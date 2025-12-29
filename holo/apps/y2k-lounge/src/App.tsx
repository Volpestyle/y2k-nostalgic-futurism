import React, { useEffect, useMemo, useRef, useState } from "react";
import { VisualizerApp } from "@holo/visualizer-three";
import {
  AppShell,
  Badge,
  Button,
  Divider,
  Panel,
  PanelTitle,
  Status,
} from "@holo/ui-kit";
import { CreateModelsPanel } from "./CreateModelsPanel";
import { LoungePanel } from "./LoungePanel";

type PageId = "lounge" | "create-models";

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

export function App() {
  const visualizerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visualizer, setVisualizer] = useState<VisualizerApp | null>(null);
  const [activePage, setActivePage] = useState<PageId>("lounge");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  const activeNavItem = useMemo(
    () => NAV_ITEMS.find((item) => item.id === activePage),
    [activePage]
  );

  useEffect(() => {
    document.body.dataset.theme = theme;
  }, [theme]);

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

  return (
    <AppShell
      className="loungeApp"
      data-sidebar={sidebarOpen ? "open" : "closed"}
    >
      <div className="loungeStage">
        <canvas ref={visualizerCanvasRef} className="loungeVisualizer" />
        <div className="loungeStageGlow" />
        <div className="loungeStageScanlines" />
      </div>

      <header className="loungeNav">
        <div className="loungeNavLeft">
          <div className="loungeBrand">
            <span className="brandMark">Y2K</span>
          </div>
        </div>

        <div className="loungeNavCenter">
          {NAV_ITEMS.map((item) => (
            <Button
              key={item.id}
              className={`loungeNavItem ${
                activePage === item.id ? "isActive" : ""
              }`}
              variant={activePage === item.id ? "primary" : "ghost"}
              onClick={() => setActivePage(item.id)}
              aria-pressed={activePage === item.id}
              title={item.label}
            >
              <span className="navIcon">{item.icon}</span>
              <span className="navLabel">{item.label}</span>
            </Button>
          ))}
        </div>

        <div className="loungeNavRight">
          <Button
            className="navControl"
            variant="ghost"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title={theme === "dark" ? "Switch to light" : "Switch to dark"}
            aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"}
            aria-pressed={theme === "dark"}
          >
            <span className="navControlIcon">
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </span>
          </Button>
        </div>
      </header>

      <aside className="loungeSidebar">
        <div className="loungeSidebarInner">
          <div className="loungeSidebarHeader">
            <div className="sidebarInfo">
              <div className="sidebarTitle">
                {activeNavItem?.label || "Console"}
              </div>
              <div className="sidebarSubtitle">HUD modules</div>
            </div>
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

            {activePage === "create-models" ? (
              <CreateModelsPanel />
            ) : (
              <LoungePanel visualizer={visualizer} />
            )}
          </div>
        </div>
      </aside>
    </AppShell>
  );
}
