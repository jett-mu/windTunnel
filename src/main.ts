import "./style.css";
import { Simulation } from "./Simulation";

const app = document.querySelector<HTMLDivElement>("#app")!;
const sim = new Simulation(app);
sim.start();
