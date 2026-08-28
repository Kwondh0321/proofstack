import type { FastifyReply } from "fastify";

export interface ProblemDetail {
  readonly code: string;
  readonly detail: string;
  readonly issues?: readonly {
    readonly message: string;
    readonly path: string;
  }[];
  readonly requestId: string;
  readonly status: number;
  readonly title: string;
  readonly type: string;
}

export function sendProblem(reply: FastifyReply, problem: ProblemDetail): FastifyReply {
  return reply.status(problem.status).type("application/problem+json").send(problem);
}
