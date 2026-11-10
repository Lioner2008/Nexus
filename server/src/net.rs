//! Networking helpers for playing across different networks:
//!
//! * a TURN relay (UDP) so WebRTC calls work even when two players are both behind strict NATs
//! * UPnP port mapping so the router forwards the server and relay ports automatically
//!
//! Voice and video are still peer-to-peer whenever possible (STUN/ICE); the relay is only the fallback.

use igd_next::{
    aio::{tokio::{search_gateway, Tokio}, Gateway},
    PortMappingProtocol,
};
use serde::Serialize;
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::net::UdpSocket;
use turn::{
    auth::LongTermAuthHandler,
    relay::relay_range::RelayAddressGeneratorRanges,
    server::{
        config::{ConnConfig, ServerConfig},
        Server,
    },
};
use util::vnet::net::Net;

pub const REALM: &str = "nexus";

/// The LAN address of this machine (no packet is sent, the OS just picks the outgoing interface).
pub fn local_ipv4() -> Option<Ipv4Addr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    match s.local_addr().ok()?.ip() {
        IpAddr::V4(v) => Some(v),
        _ => None,
    }
}

/// True for addresses a friend on the internet could never reach (private, CGNAT, link-local).
pub fn is_unroutable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            v.is_private() || v.is_loopback() || v.is_link_local() || (o[0] == 100 && (64..128).contains(&o[1]))
        }
        IpAddr::V6(v) => v.is_loopback(),
    }
}

#[derive(Serialize, Clone, Default)]
pub struct TurnInfo {
    pub enabled: bool,
    pub ok: bool,
    pub port: u16,
    pub relay: String,
    pub message: String,
}

#[derive(Serialize, Clone, Default)]
pub struct UpnpInfo {
    pub enabled: bool,
    pub ok: bool,
    pub message: String,
    pub external_ip: Option<String>,
}

/// Starts the TURN relay on `port` (UDP). Relayed media uses the ports `rmin..=rmax`.
/// Credentials are time-limited and derived from `secret` (TURN REST style), see `Hub::ice_servers`.
pub async fn start_turn(secret: &str, port: u16, relay_ip: IpAddr, rmin: u16, rmax: u16) -> Result<Server, String> {
    let conn = Arc::new(
        UdpSocket::bind(("0.0.0.0", port))
            .await
            .map_err(|e| format!("UDP port {port} is not available: {e}"))?,
    );
    Server::new(ServerConfig {
        conn_configs: vec![ConnConfig {
            conn,
            relay_addr_generator: Box::new(RelayAddressGeneratorRanges {
                relay_address: relay_ip,
                min_port: rmin,
                max_port: rmax,
                max_retries: 20,
                address: "0.0.0.0".to_owned(),
                net: Arc::new(Net::new(None)),
            }),
        }],
        realm: REALM.to_owned(),
        auth_handler: Arc::new(LongTermAuthHandler::new(secret.to_owned())),
        channel_bind_timeout: Duration::from_secs(0),
        alloc_close_notify: None,
    })
    .await
    .map_err(|e| format!("TURN relay failed to start: {e}"))
}

pub struct Upnp {
    gw: Gateway<Tokio>,
    local: Ipv4Addr,
    maps: Vec<(PortMappingProtocol, u16)>,
    pub external: IpAddr,
}

const LEASE: u32 = 3600;

impl Upnp {
    /// Asks the router (UPnP/IGD) to forward the signaling port (TCP) and the TURN ports (UDP).
    pub async fn open(local: Ipv4Addr, tcp_port: u16, udp_port: u16, rmin: u16, rmax: u16) -> Result<Upnp, String> {
        let gw = tokio::time::timeout(Duration::from_secs(6), search_gateway(Default::default()))
            .await
            .map_err(|_| "no UPnP router found (timeout)".to_string())?
            .map_err(|e| format!("no UPnP router found: {e}"))?;
        let external = gw
            .get_external_ip()
            .await
            .map_err(|e| format!("router did not tell its public address: {e}"))?;
        let mut maps = vec![(PortMappingProtocol::TCP, tcp_port), (PortMappingProtocol::UDP, udp_port)];
        maps.extend((rmin..=rmax).map(|p| (PortMappingProtocol::UDP, p)));
        let mut up = Upnp { gw, local, maps, external };
        let (essential, ok, total) = up.refresh().await;
        if !essential {
            return Err(format!("the router refused the port forwarding ({ok}/{total} ports mapped)"));
        }
        Ok(up)
    }

    /// (Re-)creates all mappings. Returns (the two essential ones worked, mapped, total).
    pub async fn refresh(&mut self) -> (bool, usize, usize) {
        let (mut ok, mut essential) = (0, 0);
        for (i, (proto, port)) in self.maps.clone().into_iter().enumerate() {
            let addr = SocketAddr::new(IpAddr::V4(self.local), port);
            if self.gw.add_port(proto, port, addr, LEASE, "Nexus").await.is_ok() {
                ok += 1;
                if i < 2 {
                    essential += 1;
                }
            }
        }
        (essential == 2, ok, self.maps.len())
    }
    pub async fn remove_all(&self) {
        for (proto, port) in &self.maps {
            let _ = self.gw.remove_port(*proto, *port).await;
        }
    }
}
