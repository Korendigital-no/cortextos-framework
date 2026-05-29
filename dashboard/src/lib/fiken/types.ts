// Fiken API types (subset we use)
// All monetary amounts are in øre (1 NOK = 100 øre)

export interface FikenCompany {
  slug: string;
  name: string;
  organizationNumber: string;
}

export interface FikenInvoice {
  invoiceId: number;
  invoiceNumber: string;
  issueDate: string;          // yyyy-MM-dd
  dueDate: string;
  net: number;                // øre
  vat: number;
  gross: number;
  settled: boolean;
  currency: string;           // ISO 4217
  customer?: { contactId?: number; name?: string };
}

export interface FikenPurchase {
  transactionId: number;
  date: string;
  kind: string;               // INVOICE | RECEIPT | etc.
  paid: boolean;
  supplier?: { name?: string };
  lines: Array<{
    account: string;
    vatType: string;
    net: number;              // øre
    vat: number;
    gross: number;
    description?: string;
  }>;
}

export interface FikenAccountBalance {
  accountNumber: string;
  accountCode: string;
  balance: number;            // øre
}

export interface FikenJournalEntry {
  journalEntryId: number;
  date: string;
  description: string;
  lines: Array<{
    account: string;
    vatType: string;
    debit: number;            // øre
    credit: number;
  }>;
}

export interface AccountingSummary {
  period: 'current_month' | 'ytd';
  revenue_nok: number;        // NOK, not øre (transformed for UI)
  costs_nok: number;
  profit_nok: number;
  vat_balance_nok: number;    // positive = owed, negative = refundable
  invoices_count: number;
  expenses_count: number;
  source: 'fiken' | 'stub';
}
