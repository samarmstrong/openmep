"use client";

import type { ModelSummary } from "@mep/model-core";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";

type ModelsResponse = {
  items: ModelSummary[];
};

export function HomeScreen() {
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const response = await fetch("/api/models", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const payload = (await response.json()) as ModelsResponse;
        if (active) {
          setModels(payload.items);
        }
      } catch (fetchError) {
        if (active) {
          setError(
            fetchError instanceof Error
              ? fetchError.message
              : "Unable to load models."
          );
        }
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const onUpload = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);

    startTransition(async () => {
      setError(null);
      try {
        const response = await fetch("/api/models", {
          method: "POST",
          body: formData
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({ error: "Upload failed." }));
          throw new Error(payload.error ?? "Upload failed.");
        }
        form.reset();
        const created = (await response.json()) as ModelSummary;
        setModels((current) => [created, ...current]);
      } catch (uploadError) {
        setError(
          uploadError instanceof Error ? uploadError.message : "Upload failed."
        );
      }
    });
  };

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">IFC ARCH + MECH Viewer</p>
        <h1>Pre-converted 2D and 3D BIM viewing, built for product workflows.</h1>
        <p className="hero-copy">
          Upload an architectural IFC with an optional mechanical IFC overlay, let the worker convert both to Fragments, then open a synchronized 3D orbit view and storey-driven 2D plan mode.
        </p>
      </section>

      <section className="card upload-card">
        <div>
          <h2>Upload IFC</h2>
          <p>Runtime path: upload ARCH and optional MECH IFCs, queue ingestion, convert to Fragments, extract a composite semantic index.</p>
        </div>
        <form className="upload-form" onSubmit={onUpload}>
          <label className="file-input">
            <span>Architecture IFC</span>
            <input name="architectureFile" type="file" accept=".ifc" required />
          </label>
          <label className="file-input">
            <span>Mechanical IFC</span>
            <input name="mechanicalFile" type="file" accept=".ifc" />
          </label>
          <button className="primary-button" disabled={isPending} type="submit">
            {isPending ? "Uploading..." : "Upload and ingest"}
          </button>
        </form>
        <p className="hint">
          Local setup: run <code>npm run db:init</code> once, then either upload here or seed the bundled sample with <code>npm run seed:sample</code>.
        </p>
        {error ? <p className="error-text">{error}</p> : null}
      </section>

      <section className="card">
        <div className="section-heading">
          <h2>Models</h2>
          <span>{models.length} tracked</span>
        </div>
        <div className="model-grid">
          {models.map((model) => (
            <article className="model-card" key={model.id}>
              <div className="model-card-header">
                <div>
                  <p className="model-name">{model.name}</p>
                  <p className="model-id">{model.id}</p>
                </div>
                <span className={`status-pill status-${model.status}`}>
                  {model.status}
                </span>
              </div>
              <div className="counts">
                <span>{model.counts.storeys} storeys</span>
                <span>{model.counts.spaces} spaces</span>
                <span>{model.counts.elements} elements</span>
              </div>
              <p className="schema-text">{model.schema ?? "Schema pending"}</p>
              {model.errorMessage ? (
                <p className="error-text">{model.errorMessage}</p>
              ) : null}
              <div className="model-card-actions">
                <Link className="secondary-button" href={`/models/${model.id}`}>
                  Open workspace
                </Link>
              </div>
            </article>
          ))}
          {models.length === 0 ? (
            <div className="empty-state">
              No models yet. Upload an IFC or seed the bundled sample file.
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
