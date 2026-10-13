// Documented Rust-only surface; auth renew likewise has no TS counterpart.
export const rustOnlyTools = [
  {
    name: 'inna_sign_in',
    description:
      'Start electronic-ID sign-in using the locally stored phone number. Show the returned verification code verbatim, including leading zeros, and ask the user to approve on their phone; then call inna_sign_in_status. Never call automatically after a failed read or in a loop. Changes only the local session; at most 10 starts per rolling 24 hours.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'inna_sign_in_status',
    description:
      'Check explicit electronic-ID sign-in: pending, approved, failed, expired, or none. Changes no school record.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];
