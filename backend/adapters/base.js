// Base platform adapter. Every adapter exposes:
//   fetchContests()  -> [{ site, name, start_time, end_time, url, is_live }]
//   fetchRating(handle) -> { current, points: [{t, rating, delta, rank, name, extra}], meta }
export class PlatformAdapter {
  constructor(site) {
    this.site = site;
  }

  async fetchContests() {
    throw new Error('not implemented');
  }

  async fetchRating(handle) {
    throw new Error('not implemented');
  }

  // Normalize a raw contest into the shared ContestRadar schema.
  normalize({ name, start_time, end_time, url, is_live = false }) {
    return {
      site: this.site,
      name: String(name || ''),
      start_time: Number(start_time),
      end_time: end_time ? Number(end_time) : null,
      url: String(url || '#'),
      is_live: Boolean(is_live)
    };
  }
}

export default PlatformAdapter;
