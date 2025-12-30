import React, { useCallback } from "react";
import { Group, GroupTitle, Hint, Input, Label, Status } from "@holo/ui-kit";

type ModelImageControlsProps = {
  file: File | null;
  onFileChange: (file: File | null) => void;
  compact?: boolean;
};

export function ModelImageControls({ file, onFileChange, compact = false }: ModelImageControlsProps) {
  const handleFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const nextFile = event.target.files?.[0] ?? null;
      onFileChange(nextFile);
      event.target.value = "";
    },
    [onFileChange]
  );

  return (
    <Group className={`modelImageControls ${compact ? "isCompact" : ""}`.trim()}>
      <GroupTitle>Model input</GroupTitle>
      <Label>
        Image file
        <Input type="file" accept="image/*" onChange={handleFile} />
      </Label>
      {!compact && <Hint>Pick an image to seed the model pipeline.</Hint>}
      <Status>{file ? `Selected: ${file.name}` : "No image selected"}</Status>
    </Group>
  );
}
