export type TurnstileVerifyResult = {
  success: boolean;
  errorCodes?: string[];
};

export async function verifyTurnstile(
  secret: string,
  responseToken: string,
  remoteip?: string
): Promise<TurnstileVerifyResult> {
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", responseToken);
  if (remoteip) form.set("remoteip", remoteip);

  const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form
  });

  const data = (await resp.json()) as any;
  return {
    success: !!data.success,
    errorCodes: data["error-codes"]
  };
}
