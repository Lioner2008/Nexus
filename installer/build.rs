fn main() {
    println!("cargo:rerun-if-changed=payload/payload.zip");
    println!("cargo:rerun-if-changed=build.rs");
    if !std::path::Path::new("payload/payload.zip").exists() {
        panic!("installer/payload/payload.zip is missing – run installer/build.ps1 (it zips nexus.exe + nexus-server.exe)");
    }
    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("../src-tauri/icons/icon.ico");
        res.set("ProductName", "Nexus Setup");
        res.set("FileDescription", "Nexus Setup");
        res.set("CompanyName", "Nexus");
        if let Err(e) = res.compile() {
            println!("cargo:warning=could not embed the icon: {e}");
        }
    }
}
