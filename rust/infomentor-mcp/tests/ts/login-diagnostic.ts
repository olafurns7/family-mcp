/** Rust-only reviewed login prefix; arbitrary error text is never normalized. */
export function loginDiagnostic(text: string) {
  const match =
    /^InfoMentor login failed at step (login-page|credential-submit|relay|isauthenticated|parent-bootstrap)(?: \(HTTP (0|[1-9][0-9]{0,4})\))?\. ([\s\S]+)$/.exec(
      text,
    );

  if (!match) return undefined;

  const step = match.at(1);
  const status = match.at(2);
  const message = match.at(3);

  if (status !== undefined && Number(status) > 65535) return undefined;

  if (!step || !message) return undefined;

  return { step, status: status === undefined ? undefined : Number(status), message };
}
