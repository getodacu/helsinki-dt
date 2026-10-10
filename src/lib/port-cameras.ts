export interface PortCamera {
  id: string; name: string; harbour: 'south' | 'west' | 'vuosaari'; kind: 'video' | 'snapshot'; url: string; pageUrl: string;
}

const PORT_PAGE = 'https://www.portofhelsinki.fi/en/about-us/port-of-helsinki/web-camera-';
export const PORT_CAMERAS: readonly PortCamera[] = [
  { id: 'south', name: 'South Harbour', harbour: 'south', kind: 'video', url: 'https://camstreamer.com/embed/3ae88840a60d5a4/S-28179', pageUrl: `${PORT_PAGE}south-harbour/` },
  { id: 'west', name: 'West Harbour', harbour: 'west', kind: 'snapshot', url: 'https://www.portofhelsinki.fi/webcams/Lansisatama.jpg', pageUrl: `${PORT_PAGE}west-harbour/` },
  { id: 'west-lt1', name: 'West Terminal 1', harbour: 'west', kind: 'video', url: 'https://camstreamer.com/embed/ma52UptmU7U6CRr1ex5jmifyNuHAdoBG5cmVWA5n/S-28179', pageUrl: `${PORT_PAGE}west-harbour-lt1/` },
  { id: 'west-lt2', name: 'West Terminal 2', harbour: 'west', kind: 'video', url: 'https://camstreamer.com/embed/kWuatAApKSPHkY3E6R4PFZnpuSCJIhHZ1qnzza8I/S-28179', pageUrl: `${PORT_PAGE}west-harbour-lt2/` },
  { id: 'west-parking', name: 'West Harbour parking', harbour: 'west', kind: 'snapshot', url: 'https://www.portofhelsinki.fi/webcams/lansisatama_p_alue.jpg', pageUrl: `${PORT_PAGE}west-harbour-p-area/` },
  { id: 'vuosaari', name: 'Vuosaari Harbour', harbour: 'vuosaari', kind: 'snapshot', url: 'https://www.portofhelsinki.fi/webcams/vuosa00001.jpg', pageUrl: `${PORT_PAGE}vuosaari-harbour/` }
];
export const PORT_HARBOURS = [
  { id: 'port-south', name: 'South Harbour', longitude: 24.958939, latitude: 60.160694, defaultCameraId: 'south' },
  { id: 'port-west', name: 'West Harbour', longitude: 24.9151515, latitude: 60.1503136, defaultCameraId: 'west-lt2' }
] as const;
export type PortHarbour = typeof PORT_HARBOURS[number];
export const PORT_SNAPSHOT_REFRESH_MS = 60_000;
export const portCameraById = (id: string) => PORT_CAMERAS.find(camera => camera.id === id);
export const portCameraUrl = (camera: PortCamera, now = Date.now()) => camera.kind === 'video'
  ? `${camera.url}?cookie=off&autoplay=0&mute=1` : `${camera.url}?${Math.floor(now / 1000)}`;
