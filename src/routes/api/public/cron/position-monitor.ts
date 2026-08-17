import { createFileRoute } from "@tanstack/react-router";

/** Lightweight paper-position protection tick. Called every 10 seconds. */
export const Route = createFileRoute("/api/public/cron/position-monitor")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const accepted = [
          process.env["CRON_SECRET"],
          process.env["SUPABASE_ANON_KEY"],
          process.env["SUPABASE_PUBLISHABLE_KEY"],
          import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"],
        ].filter((value): value is string => !!value);
        if (accepted.length === 0) return new Response("Not configured", { status: 500 });
        const provided = (request.headers.get("apikey") ?? "").trim();
        if (!accepted.some((key) => key.length === provided.length && key === provided)) {
          return new Response("Unauthorized", { status: 401 });
        }

        try {
          const { runPositionMonitor } = await import("@/lib/positionMonitor.server");
          return Response.json({ ok: true, ...(await runPositionMonitor()) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
