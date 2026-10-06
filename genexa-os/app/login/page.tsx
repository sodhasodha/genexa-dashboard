import { sendMagicLink } from "./actions";

const ERRORS: Record<string, string> = {
  email: "Enter a valid email address.",
  send: "The link could not be sent. Try again in a minute.",
  link: "That link has expired or was already used. Request a new one.",
  not_staff: "That account is not on the Genexa team. Ask Ryan to add you.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const sent = params.sent === "1";
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-panel p-6">
        <h1 className="text-lg font-semibold">Genexa OS</h1>
        {sent ? (
          <p className="mt-3 text-muted">
            If that email is on the team, a sign-in link is on its way. Open it on this device.
          </p>
        ) : (
          <form action={sendMagicLink} className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Work email
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                className="rounded border border-line px-3 py-2"
              />
            </label>
            <button type="submit" className="cursor-pointer rounded bg-ink px-3 py-2 font-medium text-white">
              Email me a sign-in link
            </button>
          </form>
        )}
        {error ? <p className="mt-3 rounded bg-bad-bg px-3 py-2 text-bad">{error}</p> : null}
      </div>
    </main>
  );
}
