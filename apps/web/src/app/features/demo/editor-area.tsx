import { NativeSelect } from "@mantine/core";
import { useState } from "react";
import { Link } from "react-router";

import { WindowLayout, WindowColumn } from "~/layouts/app-shell/window-layout";

import classes from "./editor-area.module.css";

const files = ["Brief.md", "Notes.md"] as const;

export function EditorArea() {
  const [width, setWidth] = useState(240);
  const [file, setFile] = useState<(typeof files)[number]>("Brief.md");
  const [fontSize, setFontSize] = useState("16");
  const [wrap, setWrap] = useState("soft");
  const [documents, setDocuments] = useState({ "Brief.md": "# Project brief", "Notes.md": "# Notes" });
  return (
    <WindowLayout columns={`min(${width}px, 48%) minmax(0, 1fr)`}>
      <WindowColumn as="aside" aria-label="Files" header={<strong>Files</strong>}>
        <div className={classes.files}>
          {files.map((name) => (
            <button type="button" key={name} aria-pressed={file === name} onClick={() => setFile(name)}>
              {name}
            </button>
          ))}
          <NativeSelect
            label="Font size"
            value={fontSize}
            onChange={(event) => setFontSize(event.currentTarget.value)}
            data={["14", "16", "18", "20"].map((value) => ({ value, label: value + " px" }))}
          />
          <label>
            Line wrapping
            <select value={wrap} onChange={(event) => setWrap(event.currentTarget.value)}>
              <option value="soft">Wrap lines</option>
              <option value="off">No wrapping</option>
            </select>
          </label>
          <label>
            File pane width
            <input
              type="range"
              min="160"
              max="400"
              value={width}
              onChange={(event) => setWidth(event.currentTarget.valueAsNumber)}
            />
          </label>
        </div>
      </WindowColumn>
      <WindowColumn
        primary
        header={
          <>
            <strong>{file}</strong>
            <Link to="/">Back to CRM</Link>
          </>
        }
      >
        <main className={classes.document}>
          <textarea
            aria-label={file}
            style={{ fontSize: Number(fontSize) }}
            wrap={wrap}
            value={documents[file]}
            onChange={(event) => setDocuments({ ...documents, [file]: event.target.value })}
          />
        </main>
      </WindowColumn>
    </WindowLayout>
  );
}
