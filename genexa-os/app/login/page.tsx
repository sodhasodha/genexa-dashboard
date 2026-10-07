import { sendCode, verifyCode } from "./actions";

const ERRORS: Record<string, string> = {
  email: "Enter a valid email address.",
  send: "The code could not be sent. Try again in a minute.",
  rate: "Too many codes requested. Wait a minute and try again.",
  code: "That code is wrong or has expired. Check the newest email, or send a new code.",
  link: "That link has expired or was already used. Sign in with a code instead.",
  not_staff: "That account is not on the Genexa team. Ask Ryan to add you.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const email = typeof params.email === "string" ? params.email : "";
  const onCodeStep = params.step === "code" && email !== "";
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  const field = "rounded border border-line px-3 py-2";
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-panel p-6">
        <h1 className="text-lg font-semibold">Genexa OS</h1>
        {onCodeStep ? (
          <>
            <p className="mt-3 text-sm text-muted">
              If <span className="text-ink">{email}</span> is on the team, a sign-in code is on its way. Type it here, on any device.
            </p>
            <form action={verifyCode} className="mt-4 flex flex-col gap-3">
              <input type="hidden" name="email" value={email} />
              <label className="flex flex-col gap-1 text-sm">
                Sign-in code
                <input
                  name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,12}" maxLength={12} autoFocus
                  className={`${field} text-center text-xl tracking-[0.3em]`}
                />
              </label>
              <button type="submit" className="cursor-pointer rounded bg-accent px-3 py-2 font-medium text-white">Sign in</button>
            </form>
            <form action={sendCode} className="mt-3 flex items-center justify-between text-xs text-muted">
              <input type="hidden" name="email" value={email} />
              <button type="submit" className="cursor-pointer underline">Send a new code</button>
              <a href="/login" className="underline">Use a different email</a>
            </form>
          </>
        ) : (
          <form action={sendCode} className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Work email
              <input type="email" name="email" required autoComplete="email" defaultValue={email} className={field} />
            </label>
            <button type="submit" className="cursor-pointer rounded bg-accent px-3 py-2 font-medium text-white">Email me a sign-in code</button>
          </form>
        )}
        {error ? <p className="mt-3 rounded bg-bad-bg px-3 py-2 text-bad">{error}</p> : null}
      </div>
    </main>
  );
}
