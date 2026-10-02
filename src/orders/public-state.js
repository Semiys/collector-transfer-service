// Only metadata intended for the guest. Never spread internal records here.
export function publicOrder(order) {
  return { id: order.id, amountMinor: order.amountMinor, currency: order.currency,
    paymentState: order.paymentState, processingState: order.processingState,
    attempts: order.attempts, attemptsRemaining: order.attemptsRemaining, canRetry: order.canRetry,
    createdAt: order.createdAt, updatedAt: order.updatedAt };
}

export function publicJob(job) {
  return { id: job.id, status: job.status, createdAt: job.createdAt, expiresAt: job.expiresAt,
    settling: !!job.settling, progress: { completed: job.progress.completed, total: job.progress.total,
      sourceCount: job.progress.sourceCount, modelCount: job.progress.modelCount },
    error: job.status === 'failed' ? 'Не удалось распознать коллекцию. Проверьте исходник и попробуйте позже.' : null };
}
