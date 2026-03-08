export interface PartSummary {
  lcsc: string;
  mpn: string;
  manufacturer: string | null;
  description: string;
  package: string | null;
  joints: number | null;
  stock: number;
  price_raw: string;
  img: string | null;
  url: string | null;
  part_type: string;
  pcba_type: string;
  category: string;
  subcategory: string;
  datasheet: string | null;
}

export interface SearchResponse {
  results: PartSummary[];
  total: number;
  took_ms: number;
  query: string;
}

export interface PriceTier {
  range: string;
  price: number;
}

export interface Filters {
  partTypes: string[];
  inStock: boolean;
  fuzzy: boolean;
}
