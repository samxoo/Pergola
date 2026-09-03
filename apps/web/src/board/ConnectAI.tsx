import { useEffect, useState } from "react";
import { useT } from "../lib/i18n.js";
import { copyToClipboard } from "../lib/clipboard.js";

/**
 * Hooking an AI assistant up to this instance.
 *
 * Pergola's MCP endpoint lives at /api/mcp and takes an ordinary API token, so
 * "installing" it is a matter of telling the assistant that URL and token.
 * Each client has its own way of being told: a command for Claude Code, a link
 * for VS Code and Cursor, a JSON block for anything else. The token is shown
 * once, so all of them are shown together, here, while it is still known.
 */
type Props = {
  token: string;
  onClose: () => void;
};

type Client = "claude" | "vscode" | "cursor" | "other";

export function ConnectAI({ token, onClose }: Props) {
  const t = useT();
  const [client, setClient] = useState<Client>("claude");
  const [copied, setCopied] = useState<string | null>(null);
  const url = `${location.origin}/api/mcp`;
  const auth = `Bearer ${token}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const claudeCommand = `claude mcp add --transport http --scope user pergola ${url} --header "Authorization: ${auth}"`;
  const mcpJson = JSON.stringify(
    { mcpServers: { pergola: { type: "http", url, headers: { Authorization: auth } } } },
    null,
    2,
  );
  // VS Code's URI handler takes the server object, URL-encoded.
  const vscodeLink = `vscode:mcp/install?${encodeURIComponent(
    JSON.stringify({ name: "pergola", type: "http", url, headers: { Authorization: auth } }),
  )}`;
  const vscodeJson = JSON.stringify(
    { servers: { pergola: { type: "http", url, headers: { Authorization: auth } } } },
    null,
    2,
  );
  // Cursor's deep link carries the server object base64-encoded.
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=pergola&config=${btoa(
    JSON.stringify({ url, headers: { Authorization: auth } }),
  )}`;

  const copy = async (what: string, text: string) => {
    if (await copyToClipboard(text)) {
      setCopied(what);
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 1600);
    }
  };

  const Copy = ({ what, text }: { what: string; text: string }) => (
    <button className="btn" type="button" onClick={() => void copy(what, text)}>
      {copied === what ? t("Copied") : t("Copy")}
    </button>
  );

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div className="dialog connect-ai" role="dialog" aria-labelledby="connect-ai-title">
        <h2 id="connect-ai-title" className="dialog-title">
          {t("Connect an AI assistant")}
        </h2>
        <p className="dialog-desc">
          {t(
            "The assistant will see the boards you see and act under your name: read cards, create and move them, tick checklists and leave comments. Revoke the token to end it.",
          )}
        </p>
        <p className="dialog-desc connect-warn">
          {t("This token is shown once. Set the assistant up now, or copy the token somewhere safe.")}
        </p>

        <div className="viewtabs connect-tabs" role="tablist">
          {(
            [
              ["claude", "Claude Code"],
              ["vscode", "VS Code"],
              ["cursor", "Cursor"],
              ["other", t("Other")],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={client === id}
              className={`viewtab${client === id ? " on" : ""}`}
              onClick={() => setClient(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {client === "claude" && (
          <div className="connect-pane">
            <p>{t("Run this once in a terminal. It works in the Claude Code CLI and in the VS Code extension alike, for every project.")}</p>
            <pre className="connect-code">{claudeCommand}</pre>
            <div className="dialog-actions">
              <Copy what="claude" text={claudeCommand} />
            </div>
            <p className="muted">{t("Prefer a file? Put this in a .mcp.json at the root of a project to share it with that project only:")}</p>
            <pre className="connect-code">{mcpJson}</pre>
            <div className="dialog-actions">
              <Copy what="mcpjson" text={mcpJson} />
            </div>
          </div>
        )}

        {client === "vscode" && (
          <div className="connect-pane">
            <p>{t("One click, for GitHub Copilot's agent mode in VS Code:")}</p>
            <div className="dialog-actions start">
              <a className="btn primary" href={vscodeLink}>
                {t("Install in VS Code")}
              </a>
            </div>
            <p className="muted">{t("Or add this to .vscode/mcp.json:")}</p>
            <pre className="connect-code">{vscodeJson}</pre>
            <div className="dialog-actions">
              <Copy what="vscode" text={vscodeJson} />
            </div>
          </div>
        )}

        {client === "cursor" && (
          <div className="connect-pane">
            <p>{t("One click, in Cursor:")}</p>
            <div className="dialog-actions start">
              <a className="btn primary" href={cursorLink}>
                {t("Install in Cursor")}
              </a>
            </div>
            <p className="muted">{t("Or add this to .cursor/mcp.json:")}</p>
            <pre className="connect-code">{mcpJson}</pre>
            <div className="dialog-actions">
              <Copy what="cursor" text={mcpJson} />
            </div>
          </div>
        )}

        {client === "other" && (
          <div className="connect-pane">
            <p>{t("Any MCP client that speaks Streamable HTTP can connect with these:")}</p>
            <dl className="connect-facts">
              <dt>{t("Endpoint")}</dt>
              <dd>
                <code>{url}</code> <Copy what="url" text={url} />
              </dd>
              <dt>{t("Header")}</dt>
              <dd>
                <code>Authorization: {auth}</code> <Copy what="token" text={token} />
              </dd>
            </dl>
          </div>
        )}

        <div className="dialog-actions">
          <button className="btn" type="button" onClick={onClose}>
            {t("Done")}
          </button>
        </div>
      </div>
    </>
  );
}
