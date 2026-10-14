import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ACCESS_APPLICATIONS_URL } from "../cloudflare-dashboard";
import { CopyField } from "./CopyField";
import { DashLink } from "./DashLink";
import { SettingsBlock, SettingsPanel } from "./SettingsNavigation";

/**
 * MCP clients must reach discovery, token, and /mcp without an
 * Access session. Fetching without cookies shows whether Access intercepts them.
 */
async function checkPublicOAuth(): Promise<boolean> {
  try {
    const response = await fetch("/.well-known/oauth-protected-resource/mcp", {
      credentials: "omit",
      redirect: "manual",
      cache: "no-store",
    });
    if (!response.ok) return false;
    const metadata = (await response.json()) as { resource?: string };
    return metadata.resource === `${window.location.origin}/mcp`;
  } catch {
    return false;
  }
}

export function McpSettings() {
  const status = useQuery({
    queryKey: ["mcp-public-oauth"],
    queryFn: checkPublicOAuth,
    staleTime: 0,
    refetchInterval: false,
  });
  const { origin, host } = window.location;

  return (
    <SettingsBlock
      id="mcp-settings-heading"
      title="MCP"
      description="Internal clients only. Ask an administrator to configure your client ID and callback URL before connecting. Public registration is disabled."
    >
      <SettingsPanel>
        <div className="px-4 py-4 sm:px-5">
          <CopyField value={`${origin}/mcp`} />
        </div>

        {status.data === false && (
          <div className="border-t px-4 py-4 text-[13px] leading-6 text-muted-foreground sm:px-5 [&_strong]:font-medium [&_strong]:text-foreground">
            <p>
              Access is blocking MCP clients. In{" "}
              <DashLink href={ACCESS_APPLICATIONS_URL}>Access applications</DashLink>, add a
              Self-hosted app for these paths with a <strong>Bypass</strong> policy for{" "}
              <strong>Everyone</strong>:
            </p>
            <div className="mt-3 space-y-2">
              <CopyField value={`${host}/mcp`} />
              <CopyField value={`${host}/.well-known`} />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => status.refetch()}
              disabled={status.isFetching}
            >
              {status.isFetching ? "Checking…" : "Check again"}
            </Button>
          </div>
        )}
      </SettingsPanel>
    </SettingsBlock>
  );
}
