import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  GeometryUtils,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  ShadowMaterial
} from 'three'
import matches from 'ts-matches'

import { createActionQueue, getState } from '@xrengine/hyperflux'

import { Engine } from '../ecs/classes/Engine'
import { Entity } from '../ecs/classes/Entity'
import { World } from '../ecs/classes/World'
import {
  defineComponent,
  defineQuery,
  getComponent,
  getComponentState,
  setComponent
} from '../ecs/functions/ComponentFunctions'
import { createEntity, removeEntity } from '../ecs/functions/EntityFunctions'
import { createPriorityQueue } from '../ecs/PriorityQueue'
import { EngineRenderer } from '../renderer/WebGLRendererSystem'
import { addObjectToGroup } from '../scene/components/GroupComponent'
import { NameComponent } from '../scene/components/NameComponent'
import { setVisibleComponent } from '../scene/components/VisibleComponent'
import { LocalTransformComponent, setLocalTransformComponent } from '../transform/components/TransformComponent'
import { XRPlaneComponent } from './XRComponents'
import { ReferenceSpace, XRAction, XRState } from './XRState'

/** https://github.com/immersive-web/webxr-samples/blob/main/proposals/plane-detection.html */

type DetectedPlanesType = {
  /** WebXR implements detectedPlanes on the XRFrame, but the current typescript implementation has it on worldInformation */
  detectedPlanes: XRPlaneSet
}

export const createGeometryFromPolygon = (plane: XRPlane) => {
  const geometry = new BufferGeometry()

  const polygon = plane.polygon

  const vertices = [] as number[]
  const uvs = [] as number[]

  for (const point of polygon) {
    vertices.push(point.x, point.y, point.z)
    uvs.push(point.x, point.z)
  }

  const indices = [] as number[]
  for (let i = 2; i < polygon.length; ++i) {
    indices.push(0, i - 1, i)
  }

  geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices), 3))
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
  geometry.setIndex(indices)
  return geometry
}

let planeId = 0

export const updatePlane = (entity: Entity, plane: XRPlane) => {
  const lastKnownTime = planesLastChangedTimes.get(plane) ?? 0
  if (plane.lastChangedTime > lastKnownTime) {
    planesLastChangedTimes.set(plane, plane.lastChangedTime)
    const entity = detectedPlanesMap.get(plane)!
    const geometry = createGeometryFromPolygon(plane)
    getComponentState(entity, XRPlaneComponent).geometry.set(geometry)
  }
  const planePose = Engine.instance.xrFrame!.getPose(plane.planeSpace, ReferenceSpace.localFloor!)!
  LocalTransformComponent.position.x[entity] = planePose.transform.position.x
  LocalTransformComponent.position.y[entity] = planePose.transform.position.y
  LocalTransformComponent.position.z[entity] = planePose.transform.position.z
  LocalTransformComponent.rotation.x[entity] = planePose.transform.orientation.x
  LocalTransformComponent.rotation.y[entity] = planePose.transform.orientation.y
  LocalTransformComponent.rotation.z[entity] = planePose.transform.orientation.z
  LocalTransformComponent.rotation.w[entity] = planePose.transform.orientation.w
}

export const foundPlane = (world: World, plane: XRPlane) => {
  const geometry = createGeometryFromPolygon(plane)

  const entity = createEntity()
  setLocalTransformComponent(entity, world.originEntity)
  setVisibleComponent(entity, true)
  setComponent(entity, XRPlaneComponent)
  setComponent(entity, NameComponent, 'plane-' + planeId++)

  const shadowMat = new ShadowMaterial({ opacity: 0.5, color: 0x0a0a0a })
  shadowMat.polygonOffset = true
  shadowMat.polygonOffsetFactor = -0.01
  const shadowMesh = new Mesh(geometry, shadowMat)

  const occlusionMat = new MeshBasicMaterial({ colorWrite: false })
  occlusionMat.polygonOffset = true
  occlusionMat.polygonOffsetFactor = -0.01
  const occlusionMesh = new Mesh(geometry, occlusionMat)
  occlusionMesh.renderOrder = -1 /** @todo make a global config for AR occlusion mesh renderOrder */

  const placementHelper = new Mesh(
    geometry,
    new MeshBasicMaterial({ color: 'grey', wireframe: false, opacity: 0.5, transparent: true })
  )
  occlusionMesh.add(placementHelper)

  addObjectToGroup(entity, shadowMesh)
  addObjectToGroup(entity, occlusionMesh)

  planesLastChangedTimes.set(plane, plane.lastChangedTime)
  updatePlane(entity, plane)

  setComponent(entity, XRPlaneComponent, { shadowMesh, occlusionMesh, placementHelper, geometry })

  return entity
}

export const lostPlane = (plane: XRPlane, entity: Entity) => {
  removeEntity(entity)
}

export const detectedPlanesMap = new Map<XRPlane, Entity>()
export const planesLastChangedTimes = new Map<XRPlane, number>()

export default async function XRDetectedPlanesSystem(world: World) {
  const planesQuery = defineQuery([XRPlaneComponent])

  const xrSessionChangedQueue = createActionQueue(XRAction.sessionChanged.matches)

  // detected planes should have significantly different poses very infrequently, so we can afford to run this at a low priority
  const priorityQueue = createPriorityQueue({
    accumulationBudget: 1
  })

  const execute = () => {
    for (const action of xrSessionChangedQueue()) {
      if (!action.active) {
        for (const [plane, entity] of detectedPlanesMap) {
          lostPlane(plane, entity)
          detectedPlanesMap.delete(plane)
          planesLastChangedTimes.delete(plane)
        }
        return
      }
    }
    const frame = Engine.instance.xrFrame as XRFrame & DetectedPlanesType
    if (!frame?.detectedPlanes || !ReferenceSpace.localFloor) return

    for (const [plane, entity] of detectedPlanesMap) {
      if (!frame.detectedPlanes.has(plane)) {
        lostPlane(plane, entity)
        detectedPlanesMap.delete(plane)
        planesLastChangedTimes.delete(plane)
      }
    }

    for (const plane of frame.detectedPlanes) {
      if (!detectedPlanesMap.has(plane)) {
        const entity = foundPlane(world, plane)
        detectedPlanesMap.set(plane, entity)
      }
    }

    for (const entity of planesQuery()) {
      priorityQueue.addPriority(entity, 1)
    }

    priorityQueue.update()

    for (const plane of frame.detectedPlanes) {
      const entity = detectedPlanesMap.get(plane)!
      if (!priorityQueue.priorityEntities.has(entity)) continue
      updatePlane(entity, plane)
    }
  }

  const cleanup = async () => {}

  return { execute, cleanup }
}
