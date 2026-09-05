import { useState } from "react";
import { useListBillingInvoices, getListBillingInvoicesQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, Download } from "lucide-react";
import { format } from "date-fns";
import { getSafeStripeUrl } from "@/lib/frontend-safety";

export function InvoiceList({ canManage }: { canManage: boolean }) {
  const [cursor, setCursor] = useState<string | undefined>();

  const { data, isLoading } = useListBillingInvoices(
    { limit: 10, cursor },
    { query: { enabled: !!canManage, queryKey: getListBillingInvoicesQueryKey({ limit: 10, cursor }) } }
  );

  if (!canManage) return null;

  if (isLoading) return <Skeleton className="h-[300px] w-full" />;

  if (!data || data.items.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground border border-dashed rounded-xl bg-muted/5 flex flex-col items-center justify-center">
        <div className="h-12 w-12 rounded-full bg-muted/50 flex items-center justify-center mb-4">
          <FileText className="h-6 w-6 opacity-40" />
        </div>
        <p className="font-medium">No invoices found</p>
        <p className="text-sm mt-1 opacity-70">Your billing history will appear here once you are charged.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="border rounded-xl overflow-x-auto bg-card shadow-sm">
        <table className="w-full text-sm text-left whitespace-nowrap">
          <thead className="bg-muted/30 text-muted-foreground border-b">
            <tr>
              <th className="px-6 py-4 font-semibold text-xs tracking-wider uppercase">Date</th>
              <th className="px-6 py-4 font-semibold text-xs tracking-wider uppercase">Amount</th>
              <th className="px-6 py-4 font-semibold text-xs tracking-wider uppercase">Status</th>
              <th className="px-6 py-4 font-semibold text-xs tracking-wider uppercase text-right">Invoice</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data.items.map((inv) => {
              const hostedInvoiceUrl = getSafeStripeUrl(inv.hostedInvoiceUrl);
              return (
              <tr key={inv.id} className="hover:bg-muted/30 transition-colors">
                <td className="px-6 py-4 text-foreground font-medium">{format(new Date(inv.createdAt), "MMM d, yyyy")}</td>
                <td className="px-6 py-4 font-mono text-muted-foreground">{(inv.amountDue / 100).toLocaleString('en-US', { style: 'currency', currency: inv.currency.toUpperCase() })}</td>
                <td className="px-6 py-4">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize ${
                    inv.status === 'paid' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400' :
                    inv.status === 'open' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400' :
                    'bg-muted text-muted-foreground'
                  }`}>
                    {inv.status || 'Paid'}
                  </span>
                </td>
                <td className="px-6 py-4 text-right">
                  {hostedInvoiceUrl ? (
                    <a href={hostedInvoiceUrl} target="_blank" rel="noreferrer" className="text-primary hover:text-primary/80 transition-colors inline-flex items-center gap-1.5 font-medium">
                      <Download className="h-4 w-4" /> <span>Download PDF</span>
                    </a>
                  ) : (
                    <span className="text-muted-foreground/50 text-xs italic">Not available</span>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.nextCursor && (
        <div className="flex justify-center pt-2">
          <Button variant="outline" onClick={() => setCursor(data.nextCursor!)}>Load Older Invoices</Button>
        </div>
      )}
    </div>
  );
}
