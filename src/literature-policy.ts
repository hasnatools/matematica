import type { Artifact, EventType } from "./domain";

export type LiteratureEvidenceViolation = {
  artifactId?: string;
  artifactKind?: string;
  eventId?: string;
  eventType?: string;
  reason: string;
};

export function isUntrustedLiteratureArtifact(artifact: Artifact): boolean {
  return isUntrustedLiteratureArtifactKind(artifact.kind);
}

export function isUntrustedLiteratureArtifactKind(kind: string): boolean {
  return kind.startsWith("source.") ||
    kind.includes(".source.") ||
    kind.includes(".citation") ||
    kind.includes(".citations");
}

export function isUntrustedLiteratureEventType(type: EventType | string): boolean {
  return type.startsWith("source.");
}

export function literatureArtifactViolation(artifact: Artifact): LiteratureEvidenceViolation {
  return {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    reason: "literature and citation artifacts are untrusted context, not verifier evidence"
  };
}

export function literatureEventViolation(eventId: string, eventType: EventType | string): LiteratureEvidenceViolation {
  return {
    eventId,
    eventType,
    reason: "literature and citation events are provenance context, not proof-supporting evidence"
  };
}
