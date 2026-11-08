import { useState } from "react";
import { useAuth } from "./auth";

interface AuthPanelProps {
  onClose: () => void;
  onAuthenticated?: () => void;
}

type AuthMode = "signin" | "signup" | "forgot" | "reset";

export function AuthPanel({ onClose, onAuthenticated }: AuthPanelProps) {
  const auth = useAuth();
  const [mode, setMode] = useState<AuthMode>("signin");
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ username: "", email: "", password: "", code: "" });

  const update = (key: string, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const changeMode = (next: AuthMode) => {
    auth.clearError();
    setMessage("");
    setMode(next);
  };
  const handle = async (action: () => Promise<void>, onSuccess: () => void) => {
    try {
      await action();
      onSuccess();
    } catch {
      // The auth store exposes request errors to this panel.
    }
  };

  const backLink = (
    <p className="tex-auth-link">
      <span onClick={() => changeMode("signin")} role="button" tabIndex={0} onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") changeMode("signin");
      }}>
        Back to sign in
      </span>
    </p>
  );
  const titles: Record<AuthMode, string> = {
    signin: "Sign in to Tex",
    signup: "Create your account",
    forgot: "Reset your password",
    reset: "Choose a new password"
  };

  return (
    <div className="tex-auth-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }} role="dialog" aria-modal="true" aria-labelledby="tex-auth-title">
      <section className="tex-auth-panel">
        <header className="tex-auth-header">
          <button type="button" className="tex-auth-close" aria-label="Close" onClick={onClose}>×</button>
          <h2 id="tex-auth-title">{titles[mode]}</h2>
        </header>
        <p className="tex-auth-intro">Sign in to unlock personal memory and deeper chats. Chats and provider keys stay in this browser.</p>
        {message && <p className="tex-auth-info" role="status">{message}</p>}
        {mode === "signin" && (
          <>
            <form onSubmit={(event) => {
              event.preventDefault();
              void handle(() => auth.login(form.username, form.password), () => onAuthenticated?.());
            }}>
              <label>Username<input value={form.username} onChange={(event) => update("username", event.target.value)} autoComplete="username" required /></label>
              <label>Password<input type="password" value={form.password} onChange={(event) => update("password", event.target.value)} autoComplete="current-password" required /></label>
              {auth.error && <p className="tex-auth-error" role="alert">{auth.error}</p>}
              <button type="submit" className="tex-auth-submit" disabled={auth.loading}>{auth.loading ? "Signing in…" : "Sign in"}</button>
            </form>
            <p className="tex-auth-hint">New to Tex? <span onClick={() => changeMode("signup")} role="button" tabIndex={0} onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") changeMode("signup");
            }}>Create an account</span>.</p>
            <p className="tex-auth-hint"><span onClick={() => changeMode("forgot")} role="button" tabIndex={0} onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") changeMode("forgot");
            }}>Forgot password?</span></p>
          </>
        )}
        {mode === "signup" && (
          <>
            <form onSubmit={(event) => {
              event.preventDefault();
              void handle(() => auth.register(form.username, form.email, form.password), () => {
                changeMode("signin");
                setMessage("Account created. Sign in to continue.");
              });
            }}>
              <label>Username<input value={form.username} onChange={(event) => update("username", event.target.value)} autoComplete="username" minLength={3} maxLength={30} required /></label>
              <label>Email<input type="email" value={form.email} onChange={(event) => update("email", event.target.value)} autoComplete="email" maxLength={254} required /></label>
              <label>Password<input type="password" value={form.password} onChange={(event) => update("password", event.target.value)} autoComplete="new-password" minLength={10} maxLength={128} required /></label>
              {auth.error && <p className="tex-auth-error" role="alert">{auth.error}</p>}
              <button type="submit" className="tex-auth-submit" disabled={auth.loading}>{auth.loading ? "Creating account…" : "Create account"}</button>
            </form>
            {backLink}
          </>
        )}
        {mode === "forgot" && (
          <>
            <form onSubmit={(event) => {
              event.preventDefault();
              void handle(() => auth.requestPasswordReset(form.email), () => {
                changeMode("reset");
                setMessage("If an account exists for that email, a 6-digit code has been sent.");
              });
            }}>
              <label>Email<input type="email" value={form.email} onChange={(event) => update("email", event.target.value)} autoComplete="email" required /></label>
              {auth.error && <p className="tex-auth-error" role="alert">{auth.error}</p>}
              <button type="submit" className="tex-auth-submit" disabled={auth.loading}>{auth.loading ? "Sending code…" : "Send reset code"}</button>
            </form>
            <p className="tex-auth-info">Reset codes expire after 15 minutes. Email delivery must be configured by the site owner.</p>
            {backLink}
          </>
        )}
        {mode === "reset" && (
          <>
            <form onSubmit={(event) => {
              event.preventDefault();
              void handle(() => auth.resetPassword(form.email, form.code, form.password), () => {
                changeMode("signin");
                setMessage("Password updated. Sign in with your new password.");
              });
            }}>
              <label>Email<input type="email" value={form.email} onChange={(event) => update("email", event.target.value)} autoComplete="email" required /></label>
              <label>Reset code<input inputMode="numeric" autoComplete="one-time-code" value={form.code} onChange={(event) => update("code", event.target.value)} required minLength={6} maxLength={6} /></label>
              <label>New password<input type="password" value={form.password} onChange={(event) => update("password", event.target.value)} autoComplete="new-password" minLength={10} maxLength={128} required /></label>
              {auth.error && <p className="tex-auth-error" role="alert">{auth.error}</p>}
              <button type="submit" className="tex-auth-submit" disabled={auth.loading}>{auth.loading ? "Resetting…" : "Reset password"}</button>
            </form>
            {backLink}
          </>
        )}
      </section>
    </div>
  );
}
