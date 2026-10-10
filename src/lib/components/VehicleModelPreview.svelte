<script lang="ts">
  import { onMount } from 'svelte';
  import { asset } from '$app/paths';
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  import { parseVehicleModel, disposeVehicleModel, type VehicleModel } from '#lib/vehicle-models.ts';
  import type { TransitMode } from '#lib/types.ts';

  let { mode }: { mode: Exclude<TransitMode, 'ship'> } = $props();
  let container: HTMLDivElement, canvas: HTMLCanvasElement;
  let available = $state(false);
  let rotate = (_angle: number) => {}, zoom = (_factor: number) => {}, reset = () => {};

  onMount(() => {
    const abort = new AbortController(), scene = new THREE.Scene();
    let renderer: THREE.WebGLRenderer | undefined, controls: OrbitControls | undefined;
    let model: VehicleModel | undefined, resizeObserver: ResizeObserver | undefined;
    const dispose = () => {
      if (abort.signal.aborted) return;
      abort.abort(); canvas.removeEventListener('webglcontextlost', contextLost);
      resizeObserver?.disconnect(); controls?.dispose();
      if (model) disposeVehicleModel(model);
      renderer?.dispose(); renderer?.forceContextLoss(); scene.clear();
    };
    const contextLost = () => { available = false; dispose(); };
    canvas.addEventListener('webglcontextlost', contextLost);
    void (async () => {
      const response = await fetch(asset(`models/${mode}.glb`), { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 2 * 1024 ** 2) throw new Error('Model exceeds byte budget');
      abort.signal.throwIfAborted();
      const loaded = await parseVehicleModel(bytes);
      if (abort.signal.aborted) { disposeVehicleModel(loaded); return; }
      model = loaded;
      const mesh = new THREE.Mesh(model.geometry, model.materials);
      mesh.position.sub(model.geometry.boundingBox!.getCenter(new THREE.Vector3())); scene.add(mesh);
      scene.add(new THREE.HemisphereLight('#edf9ff', '#697463', 2.2));
      const light = new THREE.DirectionalLight('#fff0d4', 2.3); light.position.set(-1, 2, 1); scene.add(light);
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); renderer.setClearColor('#0a202b');
      const radius = Math.max(model.geometry.boundingSphere!.radius, 1);
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
      resizeObserver = new ResizeObserver(resize); resizeObserver.observe(container); available = true;
    })().catch(() => { if (!abort.signal.aborted) { available = false; dispose(); } });
    return dispose;
  });

  function navigate(event: KeyboardEvent) {
    if (event.key === 'Escape') return;
    event.stopPropagation();
    if (event.key === 'ArrowLeft') rotate(-Math.PI / 8);
    else if (event.key === 'ArrowRight') rotate(Math.PI / 8);
    else if (event.key === '+' || event.key === '=') zoom(1 / 1.2);
    else if (event.key === '-') zoom(1.2);
    else if (event.key === 'Home') reset();
    else return;
    event.preventDefault();
  }
</script>

<div class="model-stage" hidden={!available} bind:this={container}>
  <canvas bind:this={canvas} tabindex="0" aria-label={`Representative 3D ${mode} model. Drag to rotate, scroll or pinch to zoom. Keyboard: left and right arrows rotate, plus and minus zoom, Home resets.`} onkeydown={navigate} onpointerdown={event => event.currentTarget.focus()}></canvas>
</div>

<style>
  .model-stage { height: 150px; margin: 8px 0; border: 1px solid #334951; border-radius: 3px; background: #0a202b; overflow: hidden; }
  .model-stage[hidden] { display: none; }
  canvas { display: block; width: 100%; height: 100%; touch-action: none; }
  canvas:focus-visible { outline: 2px solid var(--teal); outline-offset: -2px; }
</style>
