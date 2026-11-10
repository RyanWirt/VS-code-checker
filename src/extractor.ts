import { parentPort, workerData } from 'node:worker_threads';
import { extractContent } from './inputs';

void extractContent(workerData.data, workerData.extension)
  .then(content => parentPort?.postMessage(content))
  .catch(() => parentPort?.postMessage(null));
