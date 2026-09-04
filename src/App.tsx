/* App shell: boot overlay, CRT atmosphere, top bar, sidebar, routed views. */

import BootOverlay from "./components/BootOverlay";
import ErrorBanners from "./components/ErrorBanners";
import Sidebar from "./components/Sidebar";
import TopBar from "./components/TopBar";
import { StoreProvider, useStore } from "./lib/store";
import ActivityView from "./views/ActivityView";
import ConnectView from "./views/ConnectView";
import GraphView from "./views/GraphView";
import LibrarianView from "./views/LibrarianView";
import NoteView from "./views/NoteView";
import ProtocolView from "./views/ProtocolView";
import TasksView from "./views/TasksView";

function MainView() {
  const { route, notesLoaded } = useStore();
  switch (route.view) {
    case "graph":
      return <GraphView />;
    case "tasks":
      return <TasksView />;
    case "activity":
      return <ActivityView />;
    case "protocol":
      return <ProtocolView />;
    case "connect":
      return <ConnectView />;
    case "librarian":
      return <LibrarianView />;
    case "note":
      if (route.path) return <NoteView path={route.path} />;
      return (
        <div className="flex-1 flex items-center justify-center text-faint text-xs tracking-[.3em]">
          {notesLoaded ? "NO DATA IN SECTOR ░░░" : "MOUNTING MEMORY CORE ░ ░ ░"}
        </div>
      );
  }
}

function Shell() {
  return (
    <div className="h-full flex flex-col overflow-hidden">
      <TopBar />
      <div className="flex-1 flex min-h-0">
        <Sidebar />
        <main className="flex-1 flex flex-col min-h-0 min-w-0 bg-bg/60">
          <ErrorBanners />
          <MainView />
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
      <div className="fx-vignette" />
      <div className="fx-scanlines" />
      <BootOverlay />
    </StoreProvider>
  );
}

