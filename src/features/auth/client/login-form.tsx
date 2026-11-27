"use client";

import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";
import { Field, Input, describe } from "@/components/ui/form";
import { Button, Callout } from "@/components/ui/primitives";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api-client";

type Failure = "invalid" | "throttled" | "unavailable";

export function LoginForm() {
  const t = useTranslations("auth.signIn");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFailure(null);
    const result = await api("/session/login", {
      method: "POST",
      body: { email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") },
    });
    if (result.ok) {
      // Full server round-trip: the destination is decided from the verified session.
      router.replace("/");
      router.refresh();
      return;
    }
    setPending(false);
    setFailure(result.status === 429 ? "throttled" : result.status === 401 || result.status === 400 ? "invalid" : "unavailable");
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {failure ? (
        <Callout tone={failure === "invalid" ? "danger" : "warning"} role="alert" testId="login-error">
          {t(failure)}
        </Callout>
      ) : null}
      <Field id="email" label={t("email")} required>
        <Input {...describe("email", {})} name="email" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false} dir="ltr" required />
      </Field>
      <Field id="password" label={t("password")} required>
        <Input {...describe("password", {})} name="password" type="password" autoComplete="current-password" dir="ltr" required />
      </Field>
      <Button type="submit" disabled={pending} aria-busy={pending} data-testid="sign-in">
        {pending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
