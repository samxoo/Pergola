import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { Join } from "./Join.js";
import { PublicBoard } from "./PublicBoard.js";
import { DialogProvider } from "./lib/Dialogs.js";
import { I18nProvider } from "./lib/i18n.js";
import "./styles.css";
import "./styles.timeline.css";
import "./styles.admin.css";

const publicBoardId = location.pathname.startsWith("/p/")
  ? location.pathname.slice(3).split("/")[0]!
  : null;
const inviteToken = location.pathname.startsWith("/join/")
  ? location.pathname.slice(6).split("/")[0]!
  : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <DialogProvider>
        {/* One route, matched by hand: a router earns its place when there are
            more than two pages, and there are two. */}
        {publicBoardId ? (
          <PublicBoard boardId={publicBoardId} />
        ) : inviteToken ? (
          <Join token={inviteToken} />
        ) : (
          <App />
        )}
      </DialogProvider>
    </I18nProvider>
  </StrictMode>,
);
