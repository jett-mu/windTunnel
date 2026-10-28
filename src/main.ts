import "./style.css";
import { Simulation } from "./Simulation";

const app = document.querySelector<HTMLDivElement>("#app")!;

function showMessage(title: string, body: string, action?: { label: string; run: () => void }): HTMLElement {
  const card = document.createElement("div");
  card.className = "message-card";
  const h = document.createElement("h1");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = body;
  card.appendChild(h);
  card.appendChild(p);
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tool-button primary";
    b.textContent = action.label;
    b.addEventListener("click", action.run);
    card.appendChild(b);
  }
  app.appendChild(card);
  return card;
}

/**
 * Builds the simulation, rebuilding it from scratch if the GPU context is
 * lost and later restored (driver reset, GPU switch, too many contexts).
 * Everything GPU-side lives in the lost context, so a full rebuild is the
 * only reliable recovery; the URL hash carries the setup across it.
 */
function boot(): void {
  let sim: Simulation;
  try {
    sim = new Simulation(app, {
      onContextLost: () => {
        const canvas = app.querySelector("canvas");
        sim.dispose();
        let restarted = false;
        const restart = () => {
          if (restarted) return;
          restarted = true;
          card.remove();
          boot();
        };
        const card = showMessage("GPU context lost", "Waiting for the graphics driver to recover…", {
          label: "Restart now",
          run: restart,
        });
        canvas?.addEventListener("webglcontextrestored", restart, { once: true });
      },
    });
  } catch (err) {
    console.error(err);
    app.replaceChildren();
    showMessage(
      "Can't start the wind tunnel",
      "This simulator runs on the GPU and needs WebGL2 with floating-point render targets " +
        "(EXT_color_buffer_float). Try a current version of Chrome, Edge, Firefox or Safari, " +
        "and check that hardware acceleration is enabled."
    );
    return;
  }
  sim.start();
}

boot();
