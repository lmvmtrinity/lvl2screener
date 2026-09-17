import {
  createCoverageRequestSchema,
  type CoverageRequestRecord,
  type CreateCoverageRequest,
} from "@tsx-scanner/contracts";
import { PostgresCoverageRequestRepository } from "./coverage-request-repository.js";

export class CoverageRequestService {
  constructor(private readonly repository: PostgresCoverageRequestRepository) {}

  create(
    input: CreateCoverageRequest,
    idempotencyKey: string,
  ): Promise<CoverageRequestRecord> {
    return this.repository.create(
      createCoverageRequestSchema.parse(input),
      idempotencyKey,
    );
  }

  get(id: string, marketId: "CA_TSX" | "US_EQUITIES") {
    return this.repository.get(id, marketId);
  }
}
