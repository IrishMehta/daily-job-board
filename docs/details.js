const shardCache = new Map();

export async function loadJobDetail(job, { force = false } = {}) {
  if (!job?.details_shard) throw new Error("Full description is unavailable for this job.");
  const shard = String(job.details_shard);
  if (force) shardCache.delete(shard);
  if (!shardCache.has(shard)) {
    const promise = fetch(`./data/job-details/${encodeURIComponent(shard)}.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`Description request failed (${response.status}).`);
        return response.json();
      })
      .then((payload) => payload?.jobs ?? {})
      .catch((error) => {
        shardCache.delete(shard);
        throw error;
      });
    shardCache.set(shard, promise);
  }
  const jobs = await shardCache.get(shard);
  const detail = jobs[job.id];
  if (!detail) throw new Error("This description was not found in the current data refresh.");
  return detail;
}

export function clearDetailCache() {
  shardCache.clear();
}
