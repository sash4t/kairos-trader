import { createFileRoute } from "@tanstack/react-router";

/**
 * Always-on trading agent tick. Called every minute by the database scheduler.
 * Protected by a shared secret — this path bypasses site auth.
 */
export const Route = createFileRoute("/api/public/cron/trade-cycle")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected =
          process.env["SUPABASE_ANON_KEY"] ??
          process.env["SUPABASE_PUBLISHABLE_KEY"] ??
          import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"];
        if (!expected) return new Response("Not configured", { status: 500 });

        const provided = (request.headers.get("apikey") ?? "").trim();
        if (provided.length !== expected.length || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        try {
          const { runTradingCycle } = await import("@/lib/agent.server");
          const report = await runTradingCycle();
          return Response.json({ ok: true, ...report });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
