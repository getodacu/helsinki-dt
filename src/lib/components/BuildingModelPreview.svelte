<script lang="ts">
  import { onMount } from 'svelte';
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
  import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
  import { loadTexturedBuilding } from '#lib/building-model.ts';
  import { buildingName } from '#lib/inspection.ts';
  import type { CityBase } from '#lib/city-assets.ts';
  import type { CityAssetCache } from '#lib/city-cache.ts';
  import type { Building } from '#lib/types.ts';
  let { building, base, cache, visible, onavailable }: { building: Building; base: CityBase; cache?: CityAssetCache; visible: boolean; onavailable: (available: boolean) => void } = $props();
  let container: HTMLDivElement, canvas: HTMLCanvasElement;
  let rotate = (_angle: number) => {}, zoom = (_factor: number) => {}, reset = () => {};
  onMount(() => {
    const abort = new AbortController(), scene = new THREE.Scene();
    let renderer: THREE.WebGLRenderer | undefined, controls: OrbitControls | undefined, decoder: KTX2Loader | undefined;
    let model: Awaited<ReturnType<typeof loadTexturedBuilding>> = null, resizeObserver: ResizeObserver | undefined;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); renderer.setClearColor('#0a202b');
      decoder = new KTX2Loader().setWorkerLimit(1).detectSupport(renderer);
      const loader = new GLTFLoader().setKTX2Loader(decoder);
      void loadTexturedBuilding(building, base, loader, cache, abort.signal).then(loaded => {
        if (abort.signal.aborted) { loaded?.dispose(); return; }
        if (!loaded) { onavailable(false); return; }
        model = loaded; scene.add(model.root);
        scene.add(new THREE.HemisphereLight('#e7f4ff', '#596358', 2));
        const radius = Math.max(new THREE.Box3().setFromObject(model.root).getBoundingSphere(new THREE.Sphere()).radius, 1);
        const camera = new THREE.PerspectiveCamera(40, 1, radius / 100, radius * 100);
        controls = new OrbitControls(camera, canvas); controls.enablePan = false;
        controls.minDistance = radius * 1.1; controls.maxDistance = radius * 10;
        const render = () => renderer?.render(scene, camera);
        controls.addEventListener('change', render);
        reset = () => {
          const vertical = THREE.MathUtils.degToRad(camera.fov), horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
          const distance = radius / Math.sin(Math.min(vertical, horizontal) / 2) * 1.15;
          camera.position.copy(new THREE.Vector3(1, .65, 1).normalize().multiplyScalar(distance)); controls?.update(); render();
        };
        rotate = angle => { camera.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle); controls?.update(); };
        zoom = factor => { camera.position.setLength(THREE.MathUtils.clamp(camera.position.length() * factor, controls!.minDistance, controls!.maxDistance)); controls?.update(); };
        const resize = () => {
          const width = container.clientWidth, height = container.clientHeight;
          if (!width || !height) return;
          renderer?.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); reset();
        };
        resizeObserver = new ResizeObserver(resize); resizeObserver.observe(container); onavailable(true);
      }).catch(() => { if (!abort.signal.aborted) onavailable(false); })
        .finally(() => { decoder?.dispose(); decoder = undefined; });
    } catch { decoder?.dispose(); onavailable(false); }
    return () => {
      abort.abort(); resizeObserver?.disconnect(); controls?.dispose(); model?.dispose();
      renderer?.dispose(); renderer?.forceContextLoss(); scene.clear();
    };
  });
  function navigate(event: KeyboardEvent) {
    if (event.key === 'ArrowLeft') rotate(-Math.PI / 8);
    else if (event.key === 'ArrowRight') rotate(Math.PI / 8);
    else if (event.key === '+' || event.key === '=') zoom(1 / 1.2);
    else if (event.key === '-') zoom(1.2);
    else if (event.key === 'Home') reset();
    else return;
    event.preventDefault(); event.stopPropagation();
  }
</script>

<div class="model-stage" hidden={!visible} bind:this={container}>
  <canvas bind:this={canvas} tabindex="0" aria-label={`Facade-textured 3D model of ${buildingName(building)}. Drag to rotate, scroll or pinch to zoom. Keyboard: left and right arrows rotate, plus and minus zoom, Home resets.`} onkeydown={navigate}></canvas>
</div>

<style>
  .model-stage { position: relative; height: min(60dvh, 560px); min-height: 220px; background: #0a202b; }
  .model-stage[hidden] { display: none; }
  canvas { display: block; width: 100%; height: 100%; }
  canvas:focus-visible { outline: 2px solid var(--teal); outline-offset: -2px; }
</style>
