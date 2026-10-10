/// Only reviewed static messages cross the MCP and CLI boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fail {
    Safe(&'static str),
    Unknown,
    Http(u16),
}
pub type Result<T> = std::result::Result<T, Fail>;
impl mcp_runtime::Failure for Fail {
    fn is_invalid(self) -> bool {
        false
    }
    fn safe(self) -> Option<&'static str> {
        match self {
            Self::Safe(text) => Some(text),
            Self::Http(_) => Some(
                "Domino’s or its payment provider rejected the request. No automatic retry was made.",
            ),
            Self::Unknown => None,
        }
    }
}
