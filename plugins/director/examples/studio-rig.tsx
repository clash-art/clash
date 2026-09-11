/** Single-file Director component. Lighting and scenery are authored together. */
export default function StudioRig({
  parameters,
}: {
  parameters: Record<string, unknown>;
}) {
  const warm = parameters.mood !== "blue";
  const key = warm ? "#ffe0b1" : "#9fcaff";
  const rim = warm ? "#fc8747" : "#655bff";
  return (
    <group>
      <ambientLight intensity={0.22} color={key} />
      <directionalLight
        position={[-4, 7, 5]}
        intensity={3.2}
        color={key}
        castShadow
        shadow-mapSize={[2048, 2048]}
      />
      <pointLight position={[4, 4, -2]} intensity={65} color={rim} />
      <pointLight position={[-4, 2, -3]} intensity={30} color="#86d7e8" />
      <mesh position={[0, -0.1, 0]} receiveShadow>
        <boxGeometry args={[20, 0.2, 20]} />
        <meshStandardMaterial
          color={warm ? "#b7a591" : "#667589"}
          roughness={0.78}
        />
      </mesh>
      <mesh position={[0, 3.9, -3.7]} receiveShadow>
        <boxGeometry args={[20, 8, 0.2]} />
        <meshStandardMaterial
          color={warm ? "#685b50" : "#333c57"}
          roughness={0.95}
        />
      </mesh>
      {[-5, -3.3, -1.65, 0, 1.65, 3.3, 5].map((x) => (
        <mesh key={x} position={[x, 2.3, -3.53]}>
          <boxGeometry args={[0.025, 4.6, 0.05]} />
          <meshStandardMaterial
            color={rim}
            emissive={rim}
            emissiveIntensity={2}
          />
        </mesh>
      ))}
    </group>
  );
}
