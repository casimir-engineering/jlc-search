export interface JlcpartsIndex {
  categories: Record<
    string,
    Record<
      string,
      {
        sourcename: string;
        datahash: string;
        stockhash: string;
      }
    >
  >;
  created: string;
}

export interface CategoryData {
  schema: string[];
  components: unknown[][];
  category?: string;
  subcategory?: string;
}

export type StockData = Record<string, number>;

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
  price_raw: string;
  img: string | null;
  url: string | null;
  part_type: string;
  pcba_type: string;
  attributes: string;
}

export interface IngestMeta {
  category: string;
  subcategory: string;
  sourcename: string;
  datahash: string;
  stockhash: string;
  ingested_at: number;
}
