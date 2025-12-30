import React, { useCallback } from "react";
import { Button, Group, GroupTitle, Hint, Input, Label, Status } from "@holo/ui-kit";
import { useAudioLounge } from "./AudioLoungeContext";

type AudioControlsProps = {
  compact?: boolean;
};

export function AudioControls({ compact = false }: AudioControlsProps) {
  const { audioUrl, audioSource, isPlaying, loadAudioFile, togglePlay, stopAudio, toggleMic } =
    useAudioLounge();

  const handleAudioFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      loadAudioFile(file);
      event.target.value = "";
    },
    [loadAudioFile]
  );

  return (
    <Group className={`audioControls ${compact ? "isCompact" : ""}`.trim()}>
      <GroupTitle>Audio</GroupTitle>
      <Label>
        Load track
        <Input type="file" accept="audio/*" onChange={handleAudioFile} />
      </Label>
      <div className="hudControlRow">
        <Button onClick={togglePlay} disabled={!audioUrl || audioSource === "mic"}>
          {isPlaying ? "Pause" : "Play"}
        </Button>
        <Button onClick={stopAudio} disabled={!audioUrl || audioSource === "mic"} variant="ghost">
          Stop
        </Button>
        <Button onClick={toggleMic} variant="ghost">
          {audioSource === "mic" ? "Mic on" : "Mic"}
        </Button>
      </div>
      {!compact && <Hint>Pick a file or enable mic input to drive the scene.</Hint>}
      <Status>
        Source: {audioSource === "file" ? "File" : audioSource === "mic" ? "Mic" : "None"}
      </Status>
    </Group>
  );
}
