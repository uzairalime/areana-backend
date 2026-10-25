import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Round 4, P-S12: under lock contention users used to get a generic
 * 500 (Prisma P2028, transaction timeout) — indistinguishable from a
 * real bug and unretryable by the client. A lock-wait/pool timeout is
 * transient: surface it as 503 with a retryable message so the panel
 * (and a human) retries instead of reporting a broken booking.
 * Only P2028 is mapped here; every other Prisma error keeps its
 * existing handling.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaTimeoutFilter implements ExceptionFilter {
  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    if (exception.code === 'P2028') {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'Database is busy — please try again in a moment',
        error: 'Service Unavailable',
      });
    }
    throw exception;
  }
}
