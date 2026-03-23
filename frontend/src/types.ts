export interface PartSummary {
  lcsc: string;
  mpn: string;
  manufacturer: string | null;
  description: string;
  package: string | null;
  joints: number | null;
  moq: number | null;
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
  attributes: Record<string, unknown> | null;
}

export interface SearchResponse {
  results: PartSummary[];
  total: number;
  took_ms: number;
  query: string;
  categories?: { name: string; count: number }[];
}

export interface PriceTier {
  range: string;
  price: number;
}

export type SortOption = "relevance" | "price_asc" | "price_desc" | "stock_desc" | "stock_asc";

export type StockFilter = "none" | "jlc" | "lcsc" | "any";

export interface Filters {
  partTypes: string[];
  categories: string[];
  stockFilter: StockFilter;
  economicOnly: boolean;
  fuzzy: boolean;
  sort: SortOption;
  matchAll: boolean;
}
