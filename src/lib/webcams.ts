export interface Webcam {
  id: string; presetId: string; name: string; longitude: number; latitude: number;
}

export const WEBCAMS: readonly Webcam[] = [
  { id: 'C01587', presetId: 'C0158700', name: 'Kivihaka mast', longitude: 24.898843, latitude: 60.207997 },
  { id: 'C01590', presetId: 'C0159000', name: 'Ilmala', longitude: 24.907594, latitude: 60.208315 },
  { id: 'C01674', presetId: 'C0167400', name: 'Ruoholahti', longitude: 24.910959, latitude: 60.165910 },
  { id: 'C01675', presetId: 'C0167500', name: 'Lauttasaari', longitude: 24.865320, latitude: 60.162290 },
  { id: 'C01680', presetId: 'C0168000', name: 'Kivihaka west', longitude: 24.896018, latitude: 60.208150 },
  { id: 'C01706', presetId: 'C0170602', name: 'Munkkiniemi', longitude: 24.864164, latitude: 60.202314 }
];
export const WEBCAM_REFRESH_MS = 10 * 60_000;
export const WEBCAM_STALE_MS = 30 * 60_000;
export interface WebcamSnapshot {
  stationId: string; presetId: string; measuredTime: string | null; receivedAt: string | null;
  state: 'current' | 'stale' | 'unavailable'; lastError: string | null;
}
export const webcamById = (id: string) => WEBCAMS.find(camera => camera.id === id);
export const webcamImageUrl = (camera: Webcam, measuredTime: string) =>
  `https://weathercam.digitraffic.fi/${camera.presetId}.jpg?time=${encodeURIComponent(measuredTime)}`;
