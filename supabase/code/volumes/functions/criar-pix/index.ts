Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const WOOVI_APP_ID = Deno.env.get("WOOVI_APP_ID");

    if (!WOOVI_APP_ID) {
      throw new Error("WOOVI_APP_ID não configurado");
    }

    const { valor, nome } = await req.json();

    const valorNumero = Number(valor);

    if (!valorNumero || valorNumero <= 0) {
      return new Response(
        JSON.stringify({ erro: "Valor da doação inválido." }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    // Woovi trabalha em centavos
    const valorCentavos = Math.round(valorNumero * 100);

    // Identificador único da cobrança
    const correlationID = crypto.randomUUID();

    const payload = {
      correlationID,
      value: valorCentavos,
      comment: nome
        ? `Doação - ${nome}`
        : "Doação - Campanha de arrecadação",
    };

    const response = await fetch(
      "https://api.woovi.com/api/v1/charge",
      {
        method: "POST",
        headers: {
          Authorization: WOOVI_APP_ID,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro Woovi:", data);

      return new Response(
        JSON.stringify({
          erro: "Não foi possível gerar o PIX.",
          detalhes: data,
        }),
        {
          status: response.status,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    const charge = data.charge;

    if (!charge?.brCode) {
      console.error("Resposta inesperada Woovi:", data);
      throw new Error("Woovi não retornou o código PIX.");
    }

    return new Response(
      JSON.stringify({
        payment_id: correlationID,

        // Mantemos estes nomes porque seu HTML atual já espera isso.
        qr_code: charge.brCode,
        qr_code_base64: null,

        // Dados adicionais da Woovi
        qr_code_image: charge.qrCodeImage,
        payment_link: charge.paymentLinkUrl,
        status: charge.status,
        correlation_id: correlationID,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Erro criar-pix:", error);

    return new Response(
      JSON.stringify({
        erro: "Erro interno ao gerar PIX.",
        detalhes: String(error),
      }),
      {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        },
      }
    );
  }
});
