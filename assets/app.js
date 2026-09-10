import { initGraphUI } from './graph.js';
import { initRenderer, renderGraph } from './render.js';

const showDetails = initGraphUI(renderGraph);
initRenderer(showDetails);
