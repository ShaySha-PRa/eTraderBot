import { recordSecurityEvent } from "@rakazo/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";

export function isLoopbackUrl(value: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** Opt-in local development only. Issue an ordinary signed session for the configured account. */
export function localAutoLogin(email: string, origins: string[]) {
  return {
    id: "local-auto-login",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/get-session",
          handler: createAuthMiddleware(async (ctx) => {
            // Server-side session reads still require the browser's cookie.
            if (!ctx.request) return;
            const origin = ctx.headers?.get("origin");
            if (
              !isLoopbackUrl(ctx.request.url) ||
              (origin && !origins.includes(origin)) ||
              ctx.headers?.get("sec-fetch-site") === "cross-site"
            )
              return;
            const token = await ctx.getSignedCookie(
              ctx.context.authCookies.sessionToken.name,
              ctx.context.secret,
            );
            const existing = token ? await ctx.context.internalAdapter.findSession(token) : null;
            if (
              existing &&
              existing.user.email.toLowerCase() === email &&
              existing.session.expiresAt.getTime() > Date.now()
            )
              return;
            const account = await ctx.context.internalAdapter.findUserByEmail(email);
            if (!account)
              throw new APIError("SERVICE_UNAVAILABLE", {
                message: "Local auto-login account does not exist",
              });
            const session = await ctx.context.internalAdapter.createSession(account.user.id);
            if (!session)
              throw new APIError("SERVICE_UNAVAILABLE", {
                message: "Could not create local session",
              });
            await setSessionCookie(ctx, { session, user: account.user });
            await recordSecurityEvent({
              type: "auth.sign_in",
              userId: account.user.id,
              metadata: { via: "local-auto-login" },
            });
            const { token: _token, ...publicSession } = session;
            return ctx.json({ user: account.user, session: publicSession });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
