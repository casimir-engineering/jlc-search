export interface PartRow {
  lcsc: string;
  mpn: string;
  manufacturer: string | null;
  category: string;
  subcategory: string;
  description: string;
  datasheet: string | null;
  package: string | null;
  joints: number | null;
  stock: number;
  jlc_stock: number;
  price_raw: string;
  img: string | null;
  url: string | null;
  part_type: string;
  pcba_type: string;
  attributes: string;
  search_text: string;
}

export interface PartSummary {
  lcsc: string;
  mpn: string;
  manufacturer: string | null;
  description: string;
  package: string | null;
  joints: number | null;
  stock: number;
  jlc_stock: number;
  price_raw: string;
  img: string | null;
  url: string | null;
  part_type: string;
  pcba_type: string;
  category: string;
  subcategory: string;
  datasheet: string | null;
}

export interface SearchParams {
  q: string;
  partTypes: string[];
  stockFilter: "none" | "jlc" | "lcsc" | "any";
  economic?: boolean;
  fuzzy: boolean;
  limit: number;
  offset: number;
  sort: "relevance" | "price_asc" | "price_desc" | "stock_desc" | "stock_asc";
  matchAll: boolean;
}

export interface SearchResponse {
  results: PartSummary[];
  total: number;
  took_ms: number;
  query: string;
}
