//! What the native servers share around signing in: a browser login over a private Chrome
//! debugging pipe (`login`), tough-cookie's cookie parsing (`cookie`), and the JavaScript
//! semantics the TypeScript servers inherit from their runtime and zod (`js`).

pub mod cookie;
pub mod js;
mod login;

pub use login::{Cancellation, Error, Signals, Site, login_in_browser};
