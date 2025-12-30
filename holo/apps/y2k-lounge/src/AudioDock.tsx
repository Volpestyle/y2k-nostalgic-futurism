import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VisualizerApp } from "@holo/visualizer-three";
import { Button } from "@holo/ui-kit";
import { AudioControls } from "./AudioControls";
import { useAudioLounge } from "./AudioLoungeContext";
import { ModelImageControls } from "./ModelImageControls";

type AudioDockProps = {
  dockContent: DockContent;
  visualizer: VisualizerApp | null;
  dockSlotRef: React.RefObject<HTMLDivElement>;
  modelFile: File | null;
  onModelFileChange: (file: File | null) => void;
  onSwap: () => void;
};

type DockMode = "floating" | "minimized";
type DockContent = "visualizer" | "model";

type DockPosition = {
  x: number;
  y: number;
};

type DockSize = {
  width: number;
  height: number;
};

type DragState = {
  offsetX: number;
  offsetY: number;
};

type ResizeState = {
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
};

type DockStorage = {
  position?: DockPosition;
  size?: DockSize;
  controlsCollapsed?: boolean;
  isMinimized?: boolean;
};

const DOCK_STORAGE_KEY = "y2k-lounge.audio-dock";

const DOCK_MARGIN = 12;
const DOCK_MIN_WIDTH = 260;
const DOCK_MIN_HEIGHT = 150;
const DOCK_MAX_WIDTH = 520;
const DOCK_MAX_HEIGHT = 360;
const DOCK_MAX_HEIGHT_OFFSET = 160;

const DEFAULT_DOCK_POSITION: DockPosition = { x: 32, y: 120 };
const DEFAULT_DOCK_SIZE: DockSize = { width: 360, height: 200 };

const readDockStorage = (): DockStorage | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DOCK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as DockStorage;
  } catch {
    return null;
  }
};

const writeDockStorage = (payload: DockStorage) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage write errors
  }
};

const getStoredNumber = (value: unknown, fallback: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value;
};

const getStoredBoolean = (value: unknown, fallback: boolean) => {
  if (typeof value !== "boolean") return fallback;
  return value;
};

const getDockMaxWidth = () => {
  if (typeof window === "undefined") return DOCK_MAX_WIDTH;
  const maxWidth = Math.min(DOCK_MAX_WIDTH, window.innerWidth - DOCK_MARGIN * 2);
  return Math.max(maxWidth, DOCK_MIN_WIDTH);
};

const getDockMaxHeight = () => {
  if (typeof window === "undefined") return DOCK_MAX_HEIGHT;
  const maxHeight = Math.min(DOCK_MAX_HEIGHT, window.innerHeight - DOCK_MAX_HEIGHT_OFFSET);
  return Math.max(maxHeight, DOCK_MIN_HEIGHT);
};

const clampDockSize = (size: DockSize): DockSize => {
  const maxWidth = getDockMaxWidth();
  const maxHeight = getDockMaxHeight();
  return {
    width: Math.min(Math.max(size.width, DOCK_MIN_WIDTH), maxWidth),
    height: Math.min(Math.max(size.height, DOCK_MIN_HEIGHT), maxHeight)
  };
};

const clampDockPosition = (position: DockPosition, size: DockSize): DockPosition => {
  if (typeof window === "undefined") return position;
  const maxX = Math.max(DOCK_MARGIN, window.innerWidth - size.width - DOCK_MARGIN);
  const maxY = Math.max(DOCK_MARGIN, window.innerHeight - size.height - DOCK_MARGIN);
  return {
    x: Math.min(Math.max(position.x, DOCK_MARGIN), maxX),
    y: Math.min(Math.max(position.y, DOCK_MARGIN), maxY)
  };
};

const DockIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d="M3 12h3l2 4 3-8 3 7 2-3H21"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const MinimizeIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);

const CollapseIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d="M6 14l6-6 6 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ExpandIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d="M6 10l6 6 6-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const SwapIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d="M7 7h10l-2.4-2.4M17 17H7l2.4 2.4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function AudioDock({
  dockContent,
  visualizer,
  dockSlotRef,
  modelFile,
  onModelFileChange,
  onSwap
}: AudioDockProps) {
  const { audioSource, isPlaying, trackName } = useAudioLounge();
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [storedDockState] = useState(() => readDockStorage());
  const initialSize = clampDockSize({
    width: getStoredNumber(storedDockState?.size?.width, DEFAULT_DOCK_SIZE.width),
    height: getStoredNumber(storedDockState?.size?.height, DEFAULT_DOCK_SIZE.height)
  });
  const initialPosition = clampDockPosition(
    {
      x: getStoredNumber(storedDockState?.position?.x, DEFAULT_DOCK_POSITION.x),
      y: getStoredNumber(storedDockState?.position?.y, DEFAULT_DOCK_POSITION.y)
    },
    initialSize
  );
  const [isMinimized, setIsMinimized] = useState(
    getStoredBoolean(storedDockState?.isMinimized, false)
  );
  const [controlsCollapsed, setControlsCollapsed] = useState(
    getStoredBoolean(storedDockState?.controlsCollapsed, false)
  );
  const [position, setPosition] = useState(initialPosition);
  const [size, setSize] = useState(initialSize);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const touchPointsRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    startDistance: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);

  const mode: DockMode = useMemo(() => {
    return isMinimized ? "minimized" : "floating";
  }, [isMinimized]);

  const isActive = dockContent === "visualizer" && (audioSource === "mic" || isPlaying);
  const dockTitle = dockContent === "visualizer" ? "Audio lounge" : "Model forge";
  const dockSubtitle =
    dockContent === "visualizer"
      ? trackName
      : modelFile
        ? modelFile.name
        : "No image selected";

  useEffect(() => {
    if (!visualizer) return undefined;
    const frame = window.requestAnimationFrame(() => {
      visualizer.resize();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visualizer, mode, size, dockContent]);

  useEffect(() => {
    if (!dragState) return undefined;

    const handlePointerMove = (event: PointerEvent) => {
      const dockRect = dockRef.current?.getBoundingClientRect();
      const width = dockRect?.width ?? 0;
      const height = dockRect?.height ?? 0;
      const margin = DOCK_MARGIN;
      const maxX = Math.max(margin, window.innerWidth - width - margin);
      const maxY = Math.max(margin, window.innerHeight - height - margin);
      const nextX = Math.min(Math.max(event.clientX - dragState.offsetX, margin), maxX);
      const nextY = Math.min(Math.max(event.clientY - dragState.offsetY, margin), maxY);
      setPosition({ x: nextX, y: nextY });
    };

    const handlePointerUp = () => {
      setDragState(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragState]);

  useEffect(() => {
    if (!resizeState) return undefined;

    const handlePointerMove = (event: PointerEvent) => {
      const maxWidth = getDockMaxWidth();
      const maxHeight = getDockMaxHeight();
      const minWidth = DOCK_MIN_WIDTH;
      const minHeight = DOCK_MIN_HEIGHT;
      const nextWidth = Math.min(
        Math.max(resizeState.startWidth + event.clientX - resizeState.startX, minWidth),
        maxWidth
      );
      const nextHeight = Math.min(
        Math.max(resizeState.startHeight + event.clientY - resizeState.startY, minHeight),
        maxHeight
      );
      setSize({ width: nextWidth, height: nextHeight });
    };

    const handlePointerUp = () => {
      setResizeState(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [resizeState]);

  useEffect(() => {
    if (dragState || resizeState) return;
    writeDockStorage({
      position,
      size,
      isMinimized,
      controlsCollapsed
    });
  }, [position, size, isMinimized, controlsCollapsed, dragState, resizeState]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== "floating") return;
      event.preventDefault();
      setDragState({
        offsetX: event.clientX - position.x,
        offsetY: event.clientY - position.y
      });
    },
    [mode, position]
  );

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== "floating") return;
      event.preventDefault();
      event.stopPropagation();
      setResizeState({
        startX: event.clientX,
        startY: event.clientY,
        startWidth: size.width,
        startHeight: size.height
      });
    },
    [mode, size]
  );

  const handleTouchPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== "floating" || event.pointerType !== "touch") return;
      touchPointsRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY
      });
      event.currentTarget.setPointerCapture(event.pointerId);
      if (touchPointsRef.current.size === 2) {
        const points = Array.from(touchPointsRef.current.values());
        const dx = points[0].x - points[1].x;
        const dy = points[0].y - points[1].y;
        pinchRef.current = {
          startDistance: Math.hypot(dx, dy) || 1,
          startWidth: size.width,
          startHeight: size.height
        };
      }
    },
    [mode, size]
  );

  const handleTouchPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== "floating" || event.pointerType !== "touch") return;
      if (!touchPointsRef.current.has(event.pointerId)) return;
      touchPointsRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY
      });
      if (touchPointsRef.current.size !== 2 || !pinchRef.current) return;
      const points = Array.from(touchPointsRef.current.values());
      const dx = points[0].x - points[1].x;
      const dy = points[0].y - points[1].y;
      const distance = Math.hypot(dx, dy) || 1;
      const scale = distance / pinchRef.current.startDistance;
      const maxWidth = getDockMaxWidth();
      const maxHeight = getDockMaxHeight();
      const minWidth = DOCK_MIN_WIDTH;
      const minHeight = DOCK_MIN_HEIGHT;
      const nextWidth = Math.min(
        Math.max(pinchRef.current.startWidth * scale, minWidth),
        maxWidth
      );
      const nextHeight = Math.min(
        Math.max(pinchRef.current.startHeight * scale, minHeight),
        maxHeight
      );
      setSize({ width: nextWidth, height: nextHeight });
    },
    [mode]
  );

  const handleTouchPointerEnd = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "touch") return;
      touchPointsRef.current.delete(event.pointerId);
      if (touchPointsRef.current.size < 2) {
        pinchRef.current = null;
      }
    },
    []
  );

  return (
    <div
      ref={dockRef}
      className="audioDock"
      data-mode={mode}
      data-content={dockContent}
      data-controls={controlsCollapsed ? "collapsed" : "expanded"}
      style={
        {
          "--audio-dock-x": `${position.x}px`,
          "--audio-dock-y": `${position.y}px`,
          "--audio-dock-width": `${size.width}px`,
          "--audio-dock-visualizer-height": `${size.height}px`
        } as React.CSSProperties
      }
    >
      <button
        className="audioDockTab"
        type="button"
        aria-label="Expand audio controls"
        onClick={() => setIsMinimized(false)}
      >
        <span className="audioDockTabIcon">
          <DockIcon />
        </span>
      </button>

      <div className="audioDockSurface">
        <div className="audioDockBar" onPointerDown={handlePointerDown}>
          <div className="audioDockBarLeft">
            <span className="audioDockIndicator" data-state={isActive ? "live" : "idle"} />
            <span className="audioDockTitle">{dockTitle}</span>
            <span className="audioDockTrack" title={dockSubtitle}>
              {dockSubtitle}
            </span>
          </div>
          <div className="audioDockBarRight">
            <Button
              className="audioDockAction"
              variant="ghost"
              onClick={onSwap}
              onPointerDown={(event) => event.stopPropagation()}
              title="Swap preview"
              aria-label="Swap preview"
            >
              <span className="audioDockActionIcon">
                <SwapIcon />
              </span>
            </Button>
            <Button
              className="audioDockAction"
              variant="ghost"
              onClick={() => setControlsCollapsed((prev) => !prev)}
              onPointerDown={(event) => event.stopPropagation()}
              title={controlsCollapsed ? "Expand controls" : "Collapse controls"}
              aria-label={controlsCollapsed ? "Expand audio controls" : "Collapse audio controls"}
            >
              <span className="audioDockActionIcon">
                {controlsCollapsed ? <ExpandIcon /> : <CollapseIcon />}
              </span>
            </Button>
            <Button
              className="audioDockAction"
              variant="ghost"
              onClick={() => setIsMinimized(true)}
              onPointerDown={(event) => event.stopPropagation()}
              title="Minimize"
              aria-label="Minimize audio dock"
            >
              <span className="audioDockActionIcon">
                <MinimizeIcon />
              </span>
            </Button>
          </div>
        </div>

        <div
          className="audioDockVisualizer"
          onPointerDown={handleTouchPointerDown}
          onPointerMove={handleTouchPointerMove}
          onPointerUp={handleTouchPointerEnd}
          onPointerCancel={handleTouchPointerEnd}
        >
          <div className="audioDockCanvasSlot" ref={dockSlotRef} />
          <div className="audioDockOverlay" />
          <div
            className="audioDockResizeHandle"
            role="presentation"
            onPointerDown={handleResizePointerDown}
          />
        </div>

        <div className="audioDockControls">
          {dockContent === "visualizer" ? (
            <AudioControls compact />
          ) : (
            <ModelImageControls
              compact
              file={modelFile}
              onFileChange={onModelFileChange}
            />
          )}
        </div>
      </div>
    </div>
  );
}
