import { building } from '$app/env';
import { trafficMeasurements } from './lib/server/traffic-measurements.ts';

export const init = () => trafficMeasurements.start(building);
