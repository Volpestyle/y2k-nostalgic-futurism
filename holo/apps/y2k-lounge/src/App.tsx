import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { VisualizerApp } from "@holo/visualizer-three";
import {
  AppShell,
  Button,
  Divider,
  Panel,
  PanelTitle,
  Status,
} from "@holo/ui-kit";
import { AudioDock } from "./AudioDock";
import { AudioLoungeProvider } from "./AudioLoungeContext";
import { CreateModelsPanel } from "./CreateModelsPanel";
import { LoungePanel } from "./LoungePanel";
import { initAuth } from "./auth";

type PageId = "lounge" | "create-models";
type DockContent = "visualizer" | "model";

type NavItem = {
  id: PageId;
  label: string;
  icon: React.ReactNode;
};

const LoungeIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d="M2 12h3l2.2-4.5 3.2 9 3.1-6 2.4 2.5H22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const CreateModelsIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect
      x="4"
      y="4"
      width="16"
      height="16"
      rx="2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    />
    <path
      d="M4 9h16M9 4v16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

const SunIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle
      cx="12"
      cy="12"
      r="4.2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    />
    <path
      d="M12 2.5v2.6M12 18.9v2.6M4.5 12H2M22 12h-2.5M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

const MoonIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d="M18.2 15.9a7.2 7.2 0 0 1-9-9 7.6 7.6 0 1 0 9 9Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

const ToggleSidebarIcon = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d={open ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const NAV_ITEMS: NavItem[] = [
  { id: "lounge", label: "Lounge", icon: <LoungeIcon /> },
  { id: "create-models", label: "Create Models", icon: <CreateModelsIcon /> },
];

const ACTIVE_PAGE_STORAGE_KEY = "y2k-lounge.active-page";
const SIDEBAR_WIDTH_STORAGE_KEY = "y2k-lounge.sidebar-width";

const readActivePage = (): PageId | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY);
    if (raw === "lounge" || raw === "create-models") return raw;
    return null;
  } catch {
    return null;
  }
};

const writeActivePage = (page: PageId) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTIVE_PAGE_STORAGE_KEY, page);
  } catch {
    // ignore storage write errors
  }
};

const readSidebarWidth = () => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
};

const writeSidebarWidth = (value: number) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, `${Math.round(value)}`);
  } catch {
    // ignore storage write errors
  }
};

const clampSidebarWidth = (value: number, minWidth: number) => {
  if (typeof window === "undefined") return value;
  const maxWidth = Math.max(minWidth, window.innerWidth - 160);
  return Math.min(Math.max(value, minWidth), maxWidth);
};

export function App() {
  const visualizerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const modelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageSlotRef = useRef<HTMLDivElement | null>(null);
  const dockSlotRef = useRef<HTMLDivElement | null>(null);
  const [visualizer, setVisualizer] = useState<VisualizerApp | null>(null);
  const [activePage, setActivePage] = useState<PageId>(() => readActivePage() ?? "lounge");
  const [dockContent, setDockContent] = useState<DockContent>(() =>
    (readActivePage() ?? "lounge") === "create-models" ? "visualizer" : "model"
  );
  const stageContent = dockContent === "visualizer" ? "model" : "visualizer";
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const sidebarRef = useRef<HTMLElement | null>(null);
  const minSidebarWidthRef = useRef(0);

  const activeNavItem = useMemo(
    () => NAV_ITEMS.find((item) => item.id === activePage),
    [activePage]
  );

  const sidebarStyle = useMemo(() => {
    if (sidebarWidth === null) return undefined;
    return { "--lounge-sidebar-width": `${Math.round(sidebarWidth)}px` } as React.CSSProperties;
  }, [sidebarWidth]);

  useEffect(() => {
    initAuth();
  }, []);

  useEffect(() => {
    document.body.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    writeActivePage(activePage);
  }, [activePage]);

  useLayoutEffect(() => {
    if (!visualizerCanvasRef.current) {
      const canvas = document.createElement("canvas");
      canvas.className = "loungeStageCanvas loungeVisualizer";
      canvas.setAttribute("aria-hidden", "true");
      visualizerCanvasRef.current = canvas;
    }
    if (!modelCanvasRef.current) {
      const canvas = document.createElement("canvas");
      canvas.className = "loungeStageCanvas loungeModelPreview";
      canvas.setAttribute("aria-hidden", "true");
      modelCanvasRef.current = canvas;
    }
  }, []);

  useLayoutEffect(() => {
    const stageSlot = stageSlotRef.current;
    const dockSlot = dockSlotRef.current;
    const visualizerCanvas = visualizerCanvasRef.current;
    const modelCanvas = modelCanvasRef.current;
    if (!stageSlot || !dockSlot || !visualizerCanvas || !modelCanvas) return;

    if (dockContent === "visualizer") {
      dockSlot.appendChild(visualizerCanvas);
      stageSlot.appendChild(modelCanvas);
    } else {
      dockSlot.appendChild(modelCanvas);
      stageSlot.appendChild(visualizerCanvas);
    }
  }, [dockContent]);

  useEffect(() => {
    const storedWidth = readSidebarWidth();
    if (storedWidth === null) return;

    const sidebar = sidebarRef.current;
    if (sidebar && !minSidebarWidthRef.current) {
      minSidebarWidthRef.current = sidebar.getBoundingClientRect().width;
    }
    const minWidth = minSidebarWidthRef.current;
    const nextWidth = minWidth ? clampSidebarWidth(storedWidth, minWidth) : storedWidth;
    setSidebarWidth(nextWidth);
  }, []);

  useEffect(() => {
    if (sidebarWidth === null) return;
    writeSidebarWidth(sidebarWidth);
  }, [sidebarWidth]);

  useEffect(() => {
    const canvas = visualizerCanvasRef.current;
    if (!canvas) return;

    const app = new VisualizerApp(canvas, { preset: "neonRings" });
    if (app.controls) {
      app.controls.screenSpacePanning = true;
    }
    setVisualizer(app);

    const onResize = () => app.resize();
    window.addEventListener("resize", onResize);
    app.resize();

    return () => {
      window.removeEventListener("resize", onResize);
      app.dispose();
      setVisualizer(null);
    };
  }, []);

  useEffect(() => {
    const canvas = visualizerCanvasRef.current;
    if (!canvas || !visualizer) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      if (event.deltaMode !== 0) return;
      if (typeof (visualizer as any).panBy !== "function") return;
      event.preventDefault();
      (visualizer as any).panBy(event.deltaX, event.deltaY);
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", handleWheel);
    };
  }, [visualizer]);

  useEffect(() => {
    if (!visualizer) return;
    visualizer.start();
    return () => {
      visualizer.stop();
    };
  }, [visualizer]);

  useEffect(() => {
    if (!visualizer) return;
    const frame = window.requestAnimationFrame(() => {
      visualizer.resize();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visualizer, dockContent]);

  const handleSidebarResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (!sidebarOpen) return;
      const sidebar = sidebarRef.current;
      if (!sidebar) return;

      const startWidth = sidebar.getBoundingClientRect().width;
      if (!minSidebarWidthRef.current) {
        minSidebarWidthRef.current = startWidth;
      }
      const minWidth = minSidebarWidthRef.current;
      const startX = event.clientX;

      setSidebarResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handleMove = (moveEvent: PointerEvent) => {
        const delta = startX - moveEvent.clientX;
        const maxWidth = Math.max(minWidth, window.innerWidth - 160);
        const nextWidth = Math.min(Math.max(startWidth + delta, minWidth), maxWidth);
        setSidebarWidth(nextWidth);
      };

      const handleUp = () => {
        setSidebarResizing(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      event.preventDefault();
    },
    [sidebarOpen]
  );

  return (
    <AudioLoungeProvider visualizer={visualizer}>
      <AppShell
        className="loungeApp"
        data-sidebar={sidebarOpen ? "open" : "closed"}
        data-page={activePage}
        data-stage={stageContent}
        data-resizing={sidebarResizing ? "true" : "false"}
        style={sidebarStyle}
      >
        <div className="loungeStage">
          <div className="loungeStageSlot" ref={stageSlotRef} />
          <div className="loungeStageGlow" />
          <div className="loungeStageScanlines" />
        </div>

        <AudioDock
          dockContent={dockContent}
          dockSlotRef={dockSlotRef}
          modelFile={modelFile}
          onModelFileChange={setModelFile}
          onSwap={() =>
            setDockContent((prev) => (prev === "visualizer" ? "model" : "visualizer"))
          }
          visualizer={visualizer}
        />
        <div className="loungeBrand loungeBrandBadge">
          <span className="brandMark">Y2K</span>
        </div>

        <aside className="loungeSidebar" ref={sidebarRef}>
          <div
            className="loungeSidebarResize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize HUD panel"
            onPointerDown={handleSidebarResizeStart}
          />
          <div className="loungeSidebarInner">
            <div className="loungeSidebarHeader">
              <div className="sidebarHeaderTop">
                <div className="sidebarControls">
                  <Button
                    className="sidebarThemeToggle"
                    variant="ghost"
                    onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                    title={theme === "dark" ? "Switch to light" : "Switch to dark"}
                    aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"}
                    aria-pressed={theme === "dark"}
                  >
                    <span className="sidebarControlIcon">
                      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
                    </span>
                  </Button>
                  <Button
                    className="sidebarToggle"
                    variant="ghost"
                    onClick={() => setSidebarOpen((prev) => !prev)}
                    title={sidebarOpen ? "Collapse HUD" : "Expand HUD"}
                    aria-label={sidebarOpen ? "Collapse HUD" : "Expand HUD"}
                  >
                    <span className="toggleIcon">
                      <ToggleSidebarIcon open={sidebarOpen} />
                    </span>
                  </Button>
                </div>
              </div>
              <div className="sidebarTabs" role="tablist" aria-label="HUD modes">
                {NAV_ITEMS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`sidebarTab ${
                      activePage === item.id ? "isActive" : ""
                    }`}
                    role="tab"
                    aria-selected={activePage === item.id}
                    onClick={() => setActivePage(item.id)}
                    title={item.label}
                  >
                    <span className="sidebarTabIcon">{item.icon}</span>
                    <span className="sidebarTabLabel">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <Divider className="loungeDivider" />

            <div className="loungeSidebarScroll">
              <Panel className="hudPanel">
                <PanelTitle>System pulse</PanelTitle>
                <Status>
                  <div>
                    <strong>Scene:</strong> Visualizer{" "}
                    {visualizer ? "online" : "booting"}
                  </div>
                  <div>
                    <strong>HUD:</strong> {sidebarOpen ? "expanded" : "collapsed"}
                  </div>
                  <div>
                    <strong>Mode:</strong> {activeNavItem?.label || "Console"}
                  </div>
                </Status>
              </Panel>

              <div
                className="hudPage"
                data-active={activePage === "create-models"}
                aria-hidden={activePage !== "create-models"}
              >
                <CreateModelsPanel
                  stageCanvasRef={modelCanvasRef}
                  modelFile={modelFile}
                  onModelFileChange={setModelFile}
                  canvasLocation={dockContent === "model" ? "dock" : "stage"}
                />
              </div>
              <div
                className="hudPage"
                data-active={activePage === "lounge"}
                aria-hidden={activePage !== "lounge"}
              >
                <LoungePanel visualizer={visualizer} />
              </div>
            </div>
          </div>
        </aside>
      </AppShell>
    </AudioLoungeProvider>
  );
}
