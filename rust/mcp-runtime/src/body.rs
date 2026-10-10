//! `readBody`: a response body read with a byte cap.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyError {
    /// `ResponseBodyTooLargeError`: the body exceeded the cap; reading stopped there.
    TooLarge,
    /// The body could not be read.
    Failed,
}

/// The whole body, if it is at most `max_bytes` long.
pub async fn read_capped(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, BodyError> {
    let mut body = Vec::new();

    while let Some(chunk) = response.chunk().await.map_err(|_| BodyError::Failed)? {
        if body.len() + chunk.len() > max_bytes {
            return Err(BodyError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(length: usize) -> reqwest::Response {
        hyper::Response::new(vec![b'x'; length]).into()
    }

    #[tokio::test]
    async fn bodies_up_to_the_cap_are_read_and_longer_ones_refused() {
        assert_eq!(read_capped(response(7), 8).await.unwrap().len(), 7);
        assert_eq!(read_capped(response(8), 8).await.unwrap().len(), 8);
        assert_eq!(read_capped(response(9), 8).await, Err(BodyError::TooLarge));
        assert_eq!(read_capped(response(0), 0).await, Ok(Vec::new()));
    }
}
