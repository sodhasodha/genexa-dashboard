import { signIn } from "./actions";

const ERRORS: Record<string, string> = {
  invalid: "Enter your email and password.",
  wrong: "That email or password is not right.",
  rate: "Too many attempts. Wait a minute and try again.",
  not_staff: "That account is not on the Genexa team. Ask Ryan to add you.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const email = typeof params.email === "string" ? params.email : "";
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  const field = "rounded border border-line px-3 py-2";
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-panel p-6">
        <h1 className="text-lg font-semibold">Genexa OS</h1>
        <form action={signIn} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input type="email" name="email" required autoComplete="username" defaultValue={email} className={field} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Password
            <input type="password" name="password" required autoComplete="current-password" className={field} />
          </label>
          <button type="submit" className="cursor-pointer rounded bg-accent px-3 py-2 font-medium text-white">Sign in</button>
        </form>
        {error ? <p className="mt-3 rounded bg-bad-bg px-3 py-2 text-bad">{error}</p> : null}
        <p className="mt-4 text-xs text-muted">Forgotten your password? Ask Ryan to reset it.</p>
      </div>
    </main>
  );
}
