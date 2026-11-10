//! Minimal parser for Valve's KeyValues ("VDF") text format.
//! Used for Steam's libraryfolders.vdf, appmanifest_*.acf and loginusers.vdf.

#[derive(Debug, Clone)]
pub enum Vdf {
    Str(String),
    Map(Vec<(String, Vdf)>),
}

impl Vdf {
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        match self {
            Vdf::Map(v) => v
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        match self.get(key)? {
            Vdf::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn entries(&self) -> &[(String, Vdf)] {
        match self {
            Vdf::Map(v) => v,
            _ => &[],
        }
    }
}

enum Tok {
    Str(String),
    Open,
    Close,
}

fn tokenize(s: &str) -> Vec<Tok> {
    let c: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            '"' => {
                i += 1;
                let mut st = String::new();
                while i < c.len() && c[i] != '"' {
                    if c[i] == '\\' && i + 1 < c.len() {
                        i += 1;
                        st.push(match c[i] {
                            'n' => '\n',
                            't' => '\t',
                            other => other,
                        });
                    } else {
                        st.push(c[i]);
                    }
                    i += 1;
                }
                i += 1;
                out.push(Tok::Str(st));
            }
            '{' => {
                out.push(Tok::Open);
                i += 1;
            }
            '}' => {
                out.push(Tok::Close);
                i += 1;
            }
            '/' if i + 1 < c.len() && c[i + 1] == '/' => {
                while i < c.len() && c[i] != '\n' {
                    i += 1;
                }
            }
            _ => i += 1,
        }
    }
    out
}

fn parse_map(toks: &[Tok], pos: &mut usize) -> Vec<(String, Vdf)> {
    let mut v = Vec::new();
    while *pos < toks.len() {
        match &toks[*pos] {
            Tok::Close => {
                *pos += 1;
                return v;
            }
            Tok::Open => *pos += 1,
            Tok::Str(k) => {
                *pos += 1;
                match toks.get(*pos) {
                    Some(Tok::Str(val)) => {
                        v.push((k.clone(), Vdf::Str(val.clone())));
                        *pos += 1;
                    }
                    Some(Tok::Open) => {
                        *pos += 1;
                        let m = parse_map(toks, pos);
                        v.push((k.clone(), Vdf::Map(m)));
                    }
                    _ => {}
                }
            }
        }
    }
    v
}

pub fn parse(s: &str) -> Vdf {
    let toks = tokenize(s);
    let mut pos = 0;
    Vdf::Map(parse_map(&toks, &mut pos))
}
