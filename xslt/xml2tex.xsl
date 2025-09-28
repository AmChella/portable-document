<xsl:stylesheet version="1.0"
      xmlns:xsl="http://www.w3.org/1999/XSL/Transform">

  <xsl:output method="text" encoding="UTF-8" indent="no"/>

  <xsl:template match="/document">
    <xsl:apply-templates select="section"/>
  </xsl:template>

  <xsl:template match="section">
    \section{<xsl:value-of select="title"/>}
    <xsl:apply-templates select="node()[not(self::title)]"/>
  </xsl:template>

  <xsl:template match="para">
    \pdfid{<xsl:value-of select="@id"/>}
    <xsl:apply-templates/>
    \par
  </xsl:template>

  <xsl:template match="para/text()">
    <xsl:if test="normalize-space(.) != ''">
      <xsl:value-of select="normalize-space(.)"/>
    </xsl:if>
  </xsl:template>

  <xsl:template match="inline-math">
    <xsl:text> </xsl:text>$<xsl:value-of select="."/>$<xsl:text> </xsl:text>
  </xsl:template>

  <xsl:template match="equation">
    <xsl:text>\pdfid{</xsl:text><xsl:value-of select="@id"/><xsl:text>}&#10;</xsl:text>
    <xsl:text>\begin{equation}</xsl:text><xsl:text>&#10;</xsl:text>
    <xsl:if test="@label">
      <xsl:text>\label{</xsl:text><xsl:value-of select="@label"/><xsl:text>}</xsl:text><xsl:text>&#10;</xsl:text>
    </xsl:if>
    <xsl:value-of select="latex" disable-output-escaping="yes"/>
    <xsl:text>&#10;\end{equation}&#10;</xsl:text>
  </xsl:template>

  <xsl:template match="run">
    <xsl:value-of select="."/>
  </xsl:template>

  <xsl:template match="display-math">
    <xsl:if test="@id">
      <xsl:text>\pdfid{</xsl:text><xsl:value-of select="@id"/><xsl:text>}&#10;</xsl:text>
    </xsl:if>
    <xsl:text>\[</xsl:text><xsl:text>&#10;</xsl:text>
    <xsl:value-of select="." disable-output-escaping="yes"/>
    <xsl:text>&#10;\]&#10;</xsl:text>
  </xsl:template>

  <xsl:template match="list[@type='itemize']">
    \begin{itemize}
      <xsl:apply-templates select="item"/>
    \end{itemize}
  </xsl:template>

  <xsl:template match="list[@type='enumerate']">
    \begin{enumerate}
      <xsl:apply-templates select="item"/>
    \end{enumerate}
  </xsl:template>

  <xsl:template match="item">
    \item <xsl:apply-templates/>
  </xsl:template>

  <xsl:template match="figure">
    \begin{figure}[htbp]
      \centering
      \pdfid{<xsl:value-of select="@id"/>}
      <xsl:choose>
        <xsl:when test="image">
          \includegraphics[width=<xsl:value-of select="image/@width"/>]{<xsl:value-of select="image/@src"/>}
        </xsl:when>
        <xsl:when test="tikz">
          <xsl:value-of select="tikz" disable-output-escaping="yes"/>
        </xsl:when>
      </xsl:choose>
      <xsl:if test="caption">
        \caption{<xsl:value-of select="caption"/>}
      </xsl:if>
      <xsl:if test="@label">
        \label{<xsl:value-of select="@label"/>}
      </xsl:if>
    \end{figure}
  </xsl:template>

  <xsl:template match="note">
    \begin{quote}
      \pdfid{<xsl:value-of select="@id"/>}
      <xsl:apply-templates/>
    \end{quote}
  </xsl:template>

  <xsl:template match="*|text()">
    <xsl:if test="normalize-space(.) != ''">
      <xsl:value-of select="normalize-space(.)"/>
    </xsl:if>
  </xsl:template>

</xsl:stylesheet>
