import type { ProblemDocument } from "@proofstack/contracts";
import type { FastifyReply } from "fastify";

export function sendProblem(reply: FastifyReply, problem: ProblemDocument): FastifyReply {
  return reply.status(problem.status).type("application/problem+json").send(problem);
}
