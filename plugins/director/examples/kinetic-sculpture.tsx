import { MathUtils } from "three";

/** Reuse this component for independently parameterized and transformed props. */
export default function KineticSculpture({
  parameters,
  timeSeconds,
}: {
  parameters: Record<string, unknown>;
  timeSeconds: number;
}) {
  const color =
    typeof parameters.color === "string" ? parameters.color : "#da6e33";
  const phase = typeof parameters.phase === "number" ? parameters.phase : 0;
  const speed = typeof parameters.speed === "number" ? parameters.speed : 0.5;
  const angle = timeSeconds * MathUtils.clamp(speed, -4, 4) + phase;
  return (
    <group>
      <mesh position={[0, 0.4, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.9, 0.95, 0.8, 64]} />
        <meshStandardMaterial color="#ddd3c2" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.825, 0]}>
        <cylinderGeometry args={[0.85, 0.85, 0.045, 64]} />
        <meshStandardMaterial
          color="#282625"
          metalness={0.45}
          roughness={0.35}
        />
      </mesh>
      <group position={[0, 1.65, 0]} rotation={[0.2, angle, 0.1]}>
        <mesh castShadow>
          <torusKnotGeometry args={[0.43, 0.15, 144, 24, 2, 3]} />
          <meshStandardMaterial
            color={color}
            metalness={0.65}
            roughness={0.26}
          />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.78, 0.018, 12, 96]} />
          <meshStandardMaterial color={color} metalness={0.4} roughness={0.4} />
        </mesh>
      </group>
    </group>
  );
}
